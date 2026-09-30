import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { distillFromTask } from "../src/server/memory/distill.ts";
import { type MemoryCandidate, MemoryGate } from "../src/server/memory/gate.ts";
import { MemoryStore, partitionKey, VERIFICATION_STRENGTH } from "../src/server/memory/index.ts";
import { FakeRagServer } from "./helpers/fake-rag-server.ts";

/** 带内存 fake RAG 后端的 MemoryStore */
function storeWithFake(): { store: MemoryStore; fake: FakeRagServer } {
	const fake = new FakeRagServer();
	const store = new MemoryStore({
		rag: { transport: "stdio" },
		clientFactory: fake.factory(),
	});
	return { store, fake };
}

function cand(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		content: "auth 服务的 token 校验必须兼容 v1 旧版接口（历史决策）",
		category: "constraint_decision",
		source: "task:t-1",
		project: "svc/auth",
		verificationStatus: "verified_by_test",
		...over,
	};
}

describe("P4-1 memory 写入门禁", () => {
	it("四类准入：合法条目经 RAG 入库，带完整治理元数据", async () => {
		const { store, fake } = storeWithFake();
		const r = await store.admit(cand());
		expect(r.admitted).toBe(true);
		expect(r.id).toMatch(/^m_[0-9a-f]{32}$/);
		const rec = fake.recordsOf("svc/auth").find((x) => x.id === r.id);
		expect(rec?.kind).toBe("constraint_decision");
		expect(rec?.verification_status).toBe("verified_by_test");
		expect(rec?.stale_status).toBe("");
		expect(rec?.status).toBe("active");
	});

	it("写入走 memory_store 且分区 = repo/vulcan-<project>（隔离边界注入正确）", async () => {
		const { store, fake } = storeWithFake();
		await store.admit(cand());
		const call = fake.calls.find((c) => c.tool === "memory_store");
		expect(call?.args.scope).toBe("repo");
		expect(call?.args.key).toBe(partitionKey("svc/auth"));
		expect(call?.args.kind).toBe("constraint_decision");
	});

	it("unverified 猜测不作为事实入库（准入原则）", async () => {
		const { store, fake } = storeWithFake();
		const r = await store.admit(cand({ verificationStatus: "unverified" }));
		expect(r.admitted).toBe(false);
		expect(r.reason).toBe("unverified-guess");
		// observed 可入库（真实任务反复观察）
		expect((await store.admit(cand({ verificationStatus: "observed" }))).admitted).toBe(true);
		expect(fake.recordsOf("svc/auth")).toHaveLength(1);
	});

	it("排除清单：密钥/凭证内容拒绝（授权非知识）", async () => {
		expect(MemoryGate.check(cand({ content: "生产环境用 api_key: sk-abc123def456 访问" }))).toBe("secret-content");
		expect(MemoryGate.check(cand({ content: "-----BEGIN RSA PRIVATE KEY-----" }))).toBe("secret-content");
	});

	it("排除清单：完整聊天记录不入库", () => {
		const chat = [
			"用户: 帮我看下这个 bug",
			"助手: 好的，我看下日志",
			"用户: 日志在哪里",
			"助手: 在 /var/log 下",
			"用户: 谢谢",
		].join("\n");
		expect(MemoryGate.check(cand({ content: chat }))).toBe("chat-log-content");
	});

	it("正文超长拒绝而非截断（与 RAG max_text_chars=300 同口径）", () => {
		expect(MemoryGate.check(cand({ content: "x".repeat(301) }))).toBe("content-too-long");
		expect(MemoryGate.check(cand({ content: "x".repeat(300) }))).toBeNull();
	});
});

describe("P4-2 召回与失效", () => {
	it("按权限（project 分区）过滤 + 相关性排序 + 限条数与总长度", async () => {
		const { store } = storeWithFake();
		await store.admit(cand()); // svc/auth
		await store.admit(cand({ content: "支付网关幂等键 24h 过期（verify by test）", project: "svc/pay" })); // 别的项目 → 召回不到
		await store.admit(cand({ content: "svc/auth 的限流阈值在网关层配置", source: "task:t-2" })); // 相关
		const out = await store.recall({ project: "svc/auth", query: "token 限流", limit: 10 });
		expect(out).toHaveLength(2);
		expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
		// 限总长度：预算 10 字符，放不下 → 全部跳过
		const tight = await store.recall({ project: "svc/auth", query: "token 限流", maxTotalLength: 10 });
		expect(tight).toHaveLength(0);
	});

	it("空查询词 → 全量兜底召回（走管理面枚举，按时间新→旧）", async () => {
		const { store } = storeWithFake();
		await store.admit(cand({ content: "旧约束" }));
		await store.admit(cand({ content: "新约束", source: "task:t-2" }));
		const out = await store.recall({ project: "svc/auth" });
		expect(out).toHaveLength(2);
		expect(out[0].content).toBe("新约束");
	});

	it("失效：代码版本变更 → stale（召回不到）；复核 confirm 恢复 / retire 下线", async () => {
		const { store, fake } = storeWithFake();
		const admitted = await store.admit(cand({ codeVersion: "abc123" }));
		expect(await store.markCodeVersionStale("svc/auth", "abc123")).toBe(1);
		// stale 后召回不到（RAG read path 过滤 + 桥双保险）
		expect(await store.recall({ project: "svc/auth", query: "token" })).toHaveLength(0);
		expect(await store.resolveStale("svc/auth", admitted.id!, "confirm")).toBe(true);
		expect(await store.recall({ project: "svc/auth", query: "token" })).toHaveLength(1);
		// retire 下线
		expect(await store.markCodeVersionStale("svc/auth", "abc123")).toBe(1); // confirm 已恢复 active，可再次失效
		const rec = fake.recordsOf("svc/auth")[0];
		rec.stale_status = "stale"; // 直接置回待复核态再走 retire
		expect(await store.resolveStale("svc/auth", admitted.id!, "retire")).toBe(true);
		expect(await store.recall({ project: "svc/auth", query: "token" })).toHaveLength(0);
	});

	it("超期未复核 → stale（TTL 以 created_at 为基准）", async () => {
		const fake = new FakeRagServer();
		fake.seed("repo", partitionKey("svc/auth"), {
			text: "90 天前的旧约束",
			created_at: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
		});
		const store = new MemoryStore({ rag: { transport: "stdio" }, clientFactory: fake.factory() });
		expect(await store.markUnreferencedStale("svc/auth", 30 * 24 * 3600 * 1000)).toBe(1);
		expect(await store.recall({ project: "svc/auth" })).toHaveLength(0);
	});

	it("冲突裁定：按 verification_status 证据强度，不按谁更新谁赢", async () => {
		const { store, fake } = storeWithFake();
		const newButWeak = await store.admit(cand({ content: "限流阈值 100 QPS", verificationStatus: "observed" }));
		const oldButStrong = await store.admit(
			cand({ content: "限流阈值 200 QPS（测试验证）", verificationStatus: "verified_by_test" }),
		);
		expect(VERIFICATION_STRENGTH.verified_by_test).toBeGreaterThan(VERIFICATION_STRENGTH.observed);
		// 保留"旧但强"的 → "新但弱"的落败进 stale 待复核
		const loser = await store.arbitrateConflict("svc/auth", "constraint_decision", oldButStrong.id!);
		expect(loser).toBe(newButWeak.id);
		const stale = fake.recordsOf("svc/auth").find((x) => x.id === newButWeak.id);
		expect(stale?.stale_status).toBe("stale");
	});
});

describe("P4-3 离线提炼（含失败任务）", () => {
	function seedFinalTask(db: DatabaseSync, status: string): void {
		db.prepare(
			"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-d', 'alert', 'fp-d', ?, 0, 0)",
		).run(status);
		db.prepare(
			"INSERT INTO sessions (task_id, task_state, recent_window, early_summary) VALUES ('t-d', ?, '[]', NULL)",
		).run(JSON.stringify({ context: { base_commit: "abc123" }, budget: { steps_used: 8 } }));
	}

	it("非定稿态不提炼（中间态属排除清单）", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUpForTest(db);
		seedFinalTask(db, "running");
		const { store } = storeWithFake();
		const r = await distillFromTask(db, "t-d", "svc/auth", store);
		expect(r.candidates).toBe(0);
		expect(r.results[0].reason).toBe("task-not-finalized");
	});

	it("审批通过的 done 任务 → verified_fix 案例入库（带 code_version 元数据）", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUpForTest(db);
		seedFinalTask(db, "done");
		db.prepare(
			"INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at) VALUES ('AP-t-d', 't-d', 'approved', '{}', '{}', '全部 allow 满足', 'system', 0)",
		).run();
		const { store, fake } = storeWithFake();
		const r = await distillFromTask(db, "t-d", "svc/auth", store);
		expect(r.admitted).toBe(1);
		const rec = fake.recordsOf("svc/auth")[0];
		expect(rec.kind).toBe("verified_fix");
		expect(rec.verification_status).toBe("verified_by_test");
		expect(rec.code_version).toBe("abc123"); // 提炼记录代码版本，便于日后失效判断
	});

	it("失败任务 → failure_lesson（observed）入库——失败经验的主动来源", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUpForTest(db);
		seedFinalTask(db, "failed");
		const { store, fake } = storeWithFake();
		const r = await distillFromTask(db, "t-d", "svc/auth", store);
		expect(r.admitted).toBe(1);
		const rec = fake.recordsOf("svc/auth")[0];
		expect(rec.kind).toBe("failure_lesson");
		expect(rec.verification_status).toBe("observed");
	});

	it("禁止项驳回 → constraint_decision 入库，且回流内容可被召回", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUpForTest(db);
		seedFinalTask(db, "rejected");
		db.prepare(
			"INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at) VALUES ('AP-t-d', 't-d', 'rejected', '{}', '{\"deny\":[\"prod-config\"]}', '涉及生产配置', 'system', 0)",
		).run();
		const { store, fake } = storeWithFake();
		const r = await distillFromTask(db, "t-d", "svc/auth", store);
		expect(r.admitted).toBe(1);
		expect(fake.calls.some((c) => c.tool === "memory_store")).toBe(true);
		const recalled = await store.recall({ project: "svc/auth", query: "生产配置" });
		expect(recalled).toHaveLength(1);
		expect(recalled[0].category).toBe("constraint_decision");
	});
});

describe("评测支撑（P4-6 的存储侧）", () => {
	it("resetPartition 物理清空分区；countMemories 可证明为空", async () => {
		const { store, fake } = storeWithFake();
		await store.admit(cand());
		expect(await store.countMemories("svc/auth")).toBe(1);
		expect(await store.resetPartition("svc/auth")).toBe(1);
		expect(await store.countMemories("svc/auth")).toBe(0);
		expect(fake.recordsOf("svc/auth")).toHaveLength(0); // 物理删除，不是状态补丁
	});
});

// ---- 测试工具：本地库只剩任务事实表（tasks/sessions/approvals/audit_logs） ----
import { migrateUp } from "../src/server/db/migrate.ts";

function migrateUpForTest(db: DatabaseSync): void {
	migrateUp(db);
}
