import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { createGvfsRetrievalPlugin, fnv1a, type GvfsClient, type RemoteCandidate, type RemoteIndexClient, type WorkspaceLayer } from "../src/server/cordis/gvfs.ts";
import { gvfsMetricsSnapshot } from "../src/server/observability/gvfs-metrics.ts";
import { EvalRunner, type CaseRunner, type EvalCase } from "../src/server/observability/eval-runner.ts";
import { MemoryStore } from "../src/server/memory/index.ts";
import { FakeRagServer } from "./helpers/fake-rag-server.ts";

// ---------- P5-1 GVFS 三层检索 ----------

function remoteWith(candidates: RemoteCandidate[], lagMs = 0): RemoteIndexClient & { searchedAllowedRepos: string[] | null } {
	return {
		searchedAllowedRepos: null,
		async search(query, opts) {
			this.searchedAllowedRepos = opts.allowedRepos; // 记录权限是否下推
			return candidates;
		},
		async freshness() {
			return { commit: "idx-1", lagMs };
		},
	} as never;
}

const CAND: RemoteCandidate = {
	repo: "svc/auth", branch: "main", filePath: "src/login.ts", commit: "abc123",
	contentHash: "", snippet: "export function verifyToken() {}",
};

function gvfsWith(content: string): GvfsClient {
	return {
		async fetchFile() {
			return { content, contentHash: fnv1a(content), bytes: content.length };
		},
	};
}

describe("P5-1 GVFS 三层检索", () => {
	it("权限下推：allowedRepos 传给远端索引（召回前过滤，不靠事后裁剪）", async () => {
		const remote = remoteWith([CAND]);
		const plugin = createGvfsRetrievalPlugin({ remote, workspace: { localHash: () => null }, gvfs: gvfsWith("x") });
		await plugin.retrieve({ text: "verifyToken", allowedRepos: ["svc/auth"], topK: 5 });
		expect(remote.searchedAllowedRepos).toEqual(["svc/auth"]);
	});

	it("本地哈希覆盖：本地哈希一致 → 免下载直接用本地", async () => {
		const content = "export function verifyToken() {}";
		let downloads = 0;
		const remote = remoteWith([{ ...CAND, contentHash: fnv1a(content) }]);
		const gvfs: GvfsClient = { async fetchFile() { downloads += 1; return { content, contentHash: fnv1a(content), bytes: 1 }; } };
		const plugin = createGvfsRetrievalPlugin({ remote, workspace: { localHash: (p) => (p === "src/login.ts" ? fnv1a(content) : null) }, gvfs });
		const out = await plugin.retrieve({ text: "verifyToken", allowedRepos: ["svc/auth"] });
		expect(downloads).toBe(0); // 覆盖命中 → 不下载
		expect(out).toHaveLength(1);
		expect((out[0] as { via?: string }).via).toBe("local-covered");
		expect(plugin.stats().localCovered).toBe(1);
	});

	it("本地 dirty（哈希不同）→ 本地覆盖修正远端结果，不按时间判定", async () => {
		const remote = remoteWith([{ ...CAND, contentHash: "remote-hash" }]);
		const plugin = createGvfsRetrievalPlugin({
			remote,
			workspace: { localHash: () => "local-dirty-hash" },
			gvfs: gvfsWith("x"),
		});
		const out = await plugin.retrieve({ text: "q", allowedRepos: ["svc/auth"] });
		expect(out).toHaveLength(1);
		expect((out[0] as { via?: string }).via).toBe("local-dirty-overrides");
	});

	it("按需下载核验：哈希不一致 → 显式告警 + 剔除，不静默使用（验收项）", async () => {
		const staleness: Array<{ filePath: string }> = [];
		const remote = remoteWith([{ ...CAND, contentHash: "declared-hash" }]);
		const plugin = createGvfsRetrievalPlugin({
			remote,
			workspace: { localHash: () => null },
			gvfs: gvfsWith("实际内容与索引声明不一致"),
			onStale: (info) => staleness.push(info),
		});
		const out = await plugin.retrieve({ text: "q", allowedRepos: ["svc/auth"] });
		expect(out).toHaveLength(0); // 剔除
		expect(staleness).toHaveLength(1); // 显式告警
		expect(staleness[0].filePath).toBe("src/login.ts");
		expect(plugin.stats().staleExcluded).toBe(1);
	});

	it("索引过期：新鲜度超阈值触发告警，不静默使用（验收项）", async () => {
		const alerts: Array<{ lagMs: number }> = [];
		const plugin = createGvfsRetrievalPlugin({
			remote: remoteWith([], 90 * 60 * 1000), // 滞后 90 分钟
			workspace: { localHash: () => null },
			gvfs: gvfsWith("x"),
			freshnessLagThresholdMs: 30 * 60 * 1000,
			onFreshnessAlert: (a) => alerts.push(a),
		});
		await plugin.retrieve({ text: "q", allowedRepos: ["svc/auth"] });
		expect(alerts).toHaveLength(1);
		expect(alerts[0].lagMs).toBe(90 * 60 * 1000);
	});
});

// ---------- P5-2 大仓指标 ----------

describe("P5-2 大仓专属指标", () => {
	it("按需下载量与索引新鲜度进面板；超阈值触发告警（验收项）", () => {
		const stats = { queries: 4, onDemandDownloads: 1, onDemandBytes: 100, localCovered: 3, staleExcluded: 0, freshnessLagMs: 60 * 60 * 1000 };
		const { metrics, alerts } = gvfsMetricsSnapshot(stats, { freshnessThresholdMs: 30 * 60 * 1000 });
		expect(metrics.onDemandDownloads).toBe(1);
		expect(metrics.onDemandBytes).toBe(100);
		expect(metrics.localCoverageRate).toBeCloseTo(0.75);
		expect(metrics.indexFreshnessLagMs).toBe(3600_000);
		expect(alerts.some((a) => a.kind === "freshness")).toBe(true); // 面板可见 + 告警

		// 疑似全仓扫描：单次下载量爆表 → excessive-download 告警
		const heavy = gvfsMetricsSnapshot({ ...stats, queries: 1, onDemandBytes: 100 * 1024 * 1024, freshnessLagMs: 0 });
		expect(heavy.alerts.some((a) => a.kind === "excessive-download")).toBe(true);
	});
});

// ---------- P5-3 评测跑批 ----------

describe("P5-3 历史 Bug 对照数据集评测跑批", () => {
	const cases: EvalCase[] = [
		{ caseId: "bug-001", eventRef: "fp-001", issue: "登录 token 校验失败" },
		{ caseId: "bug-002", eventRef: "fp-002", issue: "限流阈值不生效" },
		{ caseId: "bug-003", eventRef: "fp-003", issue: "历史同类失败案例" },
	];

	it("对照报告：成功率/人工介入率/归因分布产出；评测模式跑完自动关闭", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUp(db);
		// 预置一条活跃记忆（若评测模式失效它会被召回 → 开卷）
		const fake = new FakeRagServer();
		const store = new MemoryStore({ rag: { transport: "stdio" }, clientFactory: fake.factory() });
		await store.admit({
			content: "历史记忆：token 问题直接改 cache", category: "verified_fix", source: "task:x", project: "svc/auth", verificationStatus: "verified_by_test",
		});
		// 预置一条失败任务 + 审计（归因分布数据源）
		db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-f', 'alert', 'fp-003', 'failed', 0, 0)").run();
		db.prepare(
			"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES ('agent', 0, 'agent', 't-f', 'tool_blocked', 'ok', ?)",
		).run(JSON.stringify({ tool: "deploy_prod", reason: "not in whitelist" }));

		const runner: CaseRunner = {
			async run(c) {
				// runner 运行期间召回必须是关闭的（防开卷）
				if ((await store.recall({ project: "svc/auth" })).length > 0) throw new Error("评测模式失效：runner 内仍能召回记忆（开卷）");
				return c.caseId === "bug-001" ? "pr_created" : c.caseId === "bug-002" ? "manual_review" : "failed";
			},
		};
		const report = await new EvalRunner(db, store, "svc/auth").run(cases, runner);
		expect(report.baselineOk).toBe(true);
		expect(report.successRate).toBeCloseTo(1 / 3);
		expect(report.manualInterventionRate).toBeCloseTo(1 / 3);
		expect(report.attribution.permission_violation).toBe(1); // t-f 命中 tool_blocked
		expect(report.cases).toHaveLength(3);
		// 跑完评测模式自动关闭 → 召回恢复
		expect((await store.recall({ project: "svc/auth" })).length).toBe(1);
		await store.close();
	});

	it("reset 跑批：先清空长期记忆再起跑（干净基线），跑完评测模式自动关闭", async () => {
		const db = new DatabaseSync(":memory:");
		migrateUp(db);
		const fake = new FakeRagServer();
		const store = new MemoryStore({ rag: { transport: "stdio" }, clientFactory: fake.factory() });
		await store.admit({
			content: "旧记忆", category: "constraint_decision", source: "task:x", project: "svc/auth", verificationStatus: "verified_by_test",
		});
		let memoryCountDuringRun = -1;
		const report = await new EvalRunner(db, store, "svc/auth").run(cases, {
			async run() {
				memoryCountDuringRun = (await store.recall({ project: "svc/auth" })).length;
				return "pr_created";
			},
		}, { resetMemories: true });
		expect(report.baselineOk).toBe(true);
		expect(memoryCountDuringRun).toBe(0); // reset 后跑批中无记忆可召回
		expect(await store.recall({ project: "svc/auth" })).toHaveLength(0); // 清空是持久的
		await store.close();
	});
});
