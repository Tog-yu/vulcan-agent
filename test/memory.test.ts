import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { MemoryGate, type MemoryCandidate } from "../src/server/memory/gate.ts";
import { MemoryStore, VERIFICATION_STRENGTH } from "../src/server/memory/index.ts";
import { distillFromTask } from "../src/server/memory/distill.ts";

function dbWithMemory(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	return db;
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
	it("四类准入：合法条目入库，带完整元信息", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		const r = gate.admit(cand());
		expect(r.admitted).toBe(true);
		const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(r.id) as Record<string, unknown>;
		expect(row.category).toBe("constraint_decision");
		expect(row.verification_status).toBe("verified_by_test");
		expect(row.stale_status).toBe("active");
	});

	it("unverified 猜测不作为事实入库（准入原则）", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		const r = gate.admit(cand({ verificationStatus: "unverified" }));
		expect(r.admitted).toBe(false);
		expect(r.reason).toBe("unverified-guess");
		// observed 可入库（真实任务反复观察）
		expect(gate.admit(cand({ verificationStatus: "observed" })).admitted).toBe(true);
	});

	it("排除清单：密钥/凭证内容拒绝（授权非知识）", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		expect(gate.admit(cand({ content: "生产环境用 api_key: sk-abc123def456 访问" })).reason).toBe("secret-content");
		expect(gate.admit(cand({ content: "-----BEGIN RSA PRIVATE KEY-----" })).reason).toBe("secret-content");
	});

	it("排除清单：完整聊天记录不入库", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		const chat = ["用户: 帮我看下这个 bug", "助手: 好的，我看下日志", "用户: 日志在哪里", "助手: 在 /var/log 下", "用户: 谢谢"].join("\n");
		expect(gate.admit(cand({ content: chat })).reason).toBe("chat-log-content");
	});
});

describe("P4-2 召回与失效", () => {
	it("按权限（project）过滤 + 相关性排序 + 限条数与总长度", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		gate.admit(cand()); // svc/auth
		gate.admit(cand({ content: "支付网关幂等键 24h 过期（verify by test）", project: "svc/pay" })); // 别的项目 → 召回不到
		gate.admit(cand({ content: "svc/auth 的限流阈值在网关层配置", source: "task:t-2" })); // 相关
		const store = new MemoryStore(db);
		const out = store.recall({ project: "svc/auth", query: "token 限流", limit: 10 });
		expect(out).toHaveLength(2);
		expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
		// 限总长度：预算 10 字符，最短的相关条目（20 字符）也放不下 → 全部跳过
		const tight = store.recall({ project: "svc/auth", query: "token 限流", maxTotalLength: 10 });
		expect(tight).toHaveLength(0);
	});

	it("失效：代码版本变更 → stale_candidate；复核 confirm/retire", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		gate.admit(cand({ codeVersion: "abc123" }));
		const store = new MemoryStore(db);
		expect(store.markCodeVersionStale("abc123")).toBe(1);
		// stale 后召回不到
		expect(store.recall({ project: "svc/auth", query: "token" })).toHaveLength(0);
		const id = (db.prepare("SELECT id FROM memories").get() as { id: string }).id;
		expect(store.resolveStale(id, "confirm")).toBe(true);
		expect(store.recall({ project: "svc/auth", query: "token" })).toHaveLength(1);
	});

	it("超期无引用 → stale_candidate", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		gate.admit(cand());
		db.prepare("UPDATE memories SET created_at = ?").run(Date.now() - 90 * 24 * 3600 * 1000); // 90 天前创建，从未被引用
		const store = new MemoryStore(db);
		expect(store.markUnreferencedStale(30 * 24 * 3600 * 1000)).toBe(1);
		expect(store.recall({ project: "svc/auth" })).toHaveLength(0);
	});

	it("冲突裁定：按 verification_status 证据强度，不按谁更新谁赢", () => {
		const db = dbWithMemory();
		const gate = new MemoryGate(db);
		const newButWeak = gate.admit(cand({ content: "限流阈值 100 QPS", verificationStatus: "observed" }));
		const oldButStrong = gate.admit(cand({ content: "限流阈值 200 QPS（测试验证）", verificationStatus: "verified_by_test" }));
		expect(VERIFICATION_STRENGTH.verified_by_test).toBeGreaterThan(VERIFICATION_STRENGTH.observed);
		const store = new MemoryStore(db);
		// 保留"旧但强"的 → "新但弱"的落败进 stale_candidate
		const loser = store.arbitrateConflict("svc/auth", "constraint_decision", oldButStrong.id!);
		expect(loser).toBe(newButWeak.id);
		const stale = db.prepare("SELECT stale_status FROM memories WHERE id = ?").get(newButWeak.id) as { stale_status: string };
		expect(stale.stale_status).toBe("stale_candidate");
	});
});

describe("P4-3 离线提炼（含失败任务）", () => {
	function seedFinalTask(db: DatabaseSync, status: string): void {
		db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-d', 'alert', 'fp-d', ?, 0, 0)").run(status);
		db.prepare(
			"INSERT INTO sessions (task_id, task_state, recent_window, early_summary) VALUES ('t-d', ?, '[]', NULL)",
		).run(JSON.stringify({ context: { base_commit: "abc123" }, budget: { steps_used: 8 } }));
	}

	it("非定稿态不提炼（中间态属排除清单）", () => {
		const db = dbWithMemory();
		seedFinalTask(db, "running");
		const r = distillFromTask(db, "t-d", "svc/auth");
		expect(r.candidates).toBe(0);
		expect(r.results[0].reason).toBe("task-not-finalized");
	});

	it("审批通过的 done 任务 → verified_fix 案例入库", () => {
		const db = dbWithMemory();
		seedFinalTask(db, "done");
		db.prepare(
			"INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at) VALUES ('AP-t-d', 't-d', 'approved', '{}', '{}', '全部 allow 满足', 'system', 0)",
		).run();
		const r = distillFromTask(db, "t-d", "svc/auth");
		expect(r.admitted).toBe(1);
		const row = db.prepare("SELECT * FROM memories").get() as Record<string, unknown>;
		expect(row.category).toBe("verified_fix");
		expect(row.verification_status).toBe("verified_by_test");
		expect(row.code_version).toBe("abc123"); // 提炼记录代码版本，便于日后失效判断
	});

	it("失败任务 → failure_lesson（observed）入库——失败经验的主动来源", () => {
		const db = dbWithMemory();
		seedFinalTask(db, "failed");
		const r = distillFromTask(db, "t-d", "svc/auth");
		expect(r.admitted).toBe(1);
		const row = db.prepare("SELECT category, verification_status FROM memories").get() as Record<string, string>;
		expect(row.category).toBe("failure_lesson");
		expect(row.verification_status).toBe("observed");
	});

	it("禁止项驳回 → constraint_decision 入库，且回流内容可被召回", () => {
		const db = dbWithMemory();
		seedFinalTask(db, "rejected");
		db.prepare(
			"INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at) VALUES ('AP-t-d', 't-d', 'rejected', '{}', '{\"deny\":[\"prod-config\"]}', '涉及生产配置', 'system', 0)",
		).run();
		const r = distillFromTask(db, "t-d", "svc/auth");
		expect(r.admitted).toBe(1);
		const store = new MemoryStore(db);
		const recalled = store.recall({ project: "svc/auth", query: "生产配置" });
		expect(recalled).toHaveLength(1);
		expect(recalled[0].row.category).toBe("constraint_decision");
	});
});
