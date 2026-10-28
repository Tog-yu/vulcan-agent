import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../src/server/db/migrate.ts";
import { defaultSummarize, renderSessionMemory, truncateMiddle } from "../src/server/session/compact.ts";
import { SessionManager, type SessionManagerDeps, type SessionMessage } from "../src/server/session/index.ts";
import { RecoveryBuilder } from "../src/server/session/recovery.ts";
import { FileSessionStorage, parsePointer } from "../src/server/session/transcript.ts";
import { initialCompactMeta, initialTaskState, SESSION_DEFAULTS } from "../src/server/session/types.ts";

// ---------- 基建 ----------

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "vulcan-sess-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function seed(taskId = "t-v2"): { db: DatabaseSync; taskId: string } {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, 'alert', 'fp-1', 'running', 0, 0)",
	).run(taskId);
	return { db, taskId };
}

function toolResult(content: string, toolName = "read_file"): SessionMessage {
	return { role: "toolResult", content, toolName, timestamp: Date.now() };
}

function manager(
	db: DatabaseSync,
	taskId: string,
	opts: Partial<SessionManagerDeps> & { withStorage?: SessionStorageLike } = {},
): { sm: SessionManager; storage: FileSessionStorage } {
	const storage = new FileSessionStorage(root);
	const { withStorage: _ignored, ...rest } = opts;
	const sm = new SessionManager(db, taskId, {
		summarize: (early, evicted) => `${early ?? ""}[摘要+${evicted.length}条]`,
		budgetTokens: 1_000_000,
		storage,
		...rest,
	});
	return { sm, storage };
}

type SessionStorageLike = unknown;

// ---------- Transcript 账本 ----------

describe("Transcript 会话账本（对照 CC 右半边）", () => {
	it("append-only：seq 单调递增、parent_id 串成链、kind 完整", () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId);
		sm.recordOnly({ role: "user", content: "修登录 bug", timestamp: 1 });
		sm.append(toolResult("r1", "read_file"));
		sm.append(toolResult("r2", "write_file"));

		const recs = storage.read(taskId);
		expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(recs.map((r) => r.kind)).toEqual(["user", "tool_result", "tool_result"]);
		// 线性会话：parent 指向上一条
		expect(recs[0]?.parent_id).toBeNull();
		expect(recs[1]?.parent_id).toBe(recs[0]?.id);
		expect(recs[2]?.parent_id).toBe(recs[1]?.id);
		expect(recs[0]?.id).toBe(`${taskId}:1`);
		// 账本保留原始事实（未压缩）
		expect(recs[1]?.payload).toBe("r1");
	});

	it("重启后 seq 续接（不重复、不覆盖）", () => {
		const { db, taskId } = seed();
		const first = manager(db, taskId).sm;
		first.append(toolResult("a"));
		first.append(toolResult("b"));

		// 新实例（模拟进程重启）
		const { sm: second, storage } = manager(db, taskId);
		second.append(toolResult("c"));
		const recs = storage.read(taskId);
		expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(recs[2]?.payload).toBe("c");
	});

	it("压缩边界落账本：compact_boundary 带窗口指标", () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId, { summaryStepInterval: 2, snipKeepRecentToolResults: 1 });
		for (let i = 0; i < 3; i++) sm.append(toolResult(`r${i}`));
		const boundary = storage.read(taskId).filter((r) => r.kind === "compact_boundary");
		expect(boundary.length).toBeGreaterThan(0);
		expect(boundary[0]?.payload).toMatchObject({ window_items: expect.any(Number) });
	});
});

// ---------- L1 Snip ----------

describe("L1 Snip：清旧只读工具结果", () => {
	it("保留最近 N 条原文，更早的替换为标记；消息结构不删", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { snipKeepRecentToolResults: 2 });
		for (let i = 0; i < 5; i++) sm.append(toolResult(`r${i}`));
		const w = sm.snapshot().recentWindow;
		expect(w).toHaveLength(5); // 条数不变，只换 content
		expect(w[0]?.cleared).toBe(true);
		expect(w[2]?.cleared).toBe(true);
		expect(w[3]?.cleared).toBeUndefined();
		expect(w[4]?.cleared).toBeUndefined();
		// tool_use / tool_result 配对信息保留
		expect(w[0]?.role).toBe("toolResult");
		expect(w[0]?.toolName).toBe("read_file");
		expect(w[0]?.content).toContain("[Old tool result content cleared: read_file");
	});

	it("保护名单不清：write_file / run_tests 永远保留原文", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { snipKeepRecentToolResults: 0 });
		sm.append(toolResult("patch-evidence", "write_file"));
		sm.append(toolResult("test-evidence", "run_tests"));
		const w = sm.snapshot().recentWindow;
		expect(w[0]?.cleared).toBeUndefined();
		expect(w[0]?.content).toBe("patch-evidence");
		expect(w[1]?.content).toBe("test-evidence");
	});
});

// ---------- L2 外置 ----------

describe("L2 外置 + 指针回灌", () => {
	it("单条超阈值 → 原文落 artifact，窗口只留指针 + 预览", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { externalizeThresholdTokens: 1_000 });
		const big = JSON.stringify({ path: "src/big.log", content: "x".repeat(40_000) });
		sm.append(toolResult(big));
		const m = sm.snapshot().recentWindow[0] as SessionMessage;
		expect(m.ref).toMatch(/^artifact:t-v2\/[0-9a-f]{64}$/);
		expect(parsePointer(m.content)).not.toBeNull();
		expect(m.content.length).toBeLessThan(3_000); // 指针 + 2KB 预览
		// 回灌拿回完整原文
		expect(sm.rehydrate(m.ref as string)).toBe(big);
	});

	it("同内容外置幂等（SHA-256 去重）", () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId, { externalizeThresholdTokens: 10 });
		const content = `y`.repeat(10_000);
		sm.append(toolResult(content));
		sm.append(toolResult(content));
		const refs = sm
			.snapshot()
			.recentWindow.map((m) => m.ref)
			.filter(Boolean);
		expect(new Set(refs).size).toBe(1);
		expect(storage.rehydrate(refs[0] as string)).toBe(content);
	});
});

// ---------- L4 硬预算 ----------

describe("L4 硬预算：修掉 v1 的两个坑", () => {
	it("坑 A：单条独占超限时不再死守 → 外置后回到上限内", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { budgetTokens: 1e9 });
		const huge = `z`.repeat(400_000); // ~100K tokens > 70K
		sm.append(toolResult(huge));
		const snap = sm.snapshot();
		const tokens = snap.recentWindow.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
		expect(tokens).toBeLessThan(SESSION_DEFAULTS.windowTokenLimit);
		expect(snap.recentWindow[0]?.ref).toBeTruthy();
	});

	it("坑 B：先外置最大条目，而不是丢掉最早出现的证据", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { budgetTokens: 1e9, snipKeepRecentToolResults: 99 });
		// 最早一条最大（证据），后面都是小条目
		sm.append(toolResult(`IMPORTANT`.padEnd(300_000, "a")));
		for (let i = 0; i < 3; i++) sm.append(toolResult(`small-${i}`));
		const w = sm.snapshot().recentWindow;
		// 大条目没被丢弃，而是外置成指针（原文仍可取回）
		expect(w[0]?.ref).toBeTruthy();
		expect(sm.rehydrate(w[0]?.ref as string)).toContain("IMPORTANT");
		expect(w.length).toBe(4);
	});
});

// ---------- 用量上报 ----------

describe("usage 上报（v1 的 token 触发失效修正）", () => {
	it("noteUsage 累计进权威层 budget，且不依赖工具调用", () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId, { budgetTokens: 1_000 });
		sm.noteUsage(400);
		sm.noteUsage(300);
		expect(sm.getTaskState().budget.tokens_used).toBe(700);
		// 700 ≥ 1000 × 0.6 → 已越过触发线
		expect(sm.noteUsage(0).summaryTriggered).toBe(false);
		expect(sm.noteUsage(1).summaryTriggered).toBe(true);
	});
});

// ---------- Session Memory ----------

describe("Session Memory（L3 的零 LLM 摘要源）", () => {
	it("9 段结构化模板：目标 / 文件 / 证伪假设 / 待办齐全", () => {
		const state = {
			...initialTaskState("t-1"),
			objective: { ...initialTaskState("t-1").objective, issue: "修 token 校验" },
			assumptions: [{ id: "a1", text: "旧 token 未过期", status: "refuted" as const, evidence: "单测复现" }],
			todos: ["补回归测试"],
		};
		const md = renderSessionMemory(state, [toolResult("{}", "read_file")], initialCompactMeta());
		for (const section of [
			"## 核心请求",
			"## 关键概念 / 约束",
			"## 涉及文件",
			"## 错误与修复",
			"## 问题解决过程",
			"## 待办",
			"## 当前工作",
			"## 下一步",
		]) {
			expect(md).toContain(section);
		}
		expect(md).toContain("修 token 校验");
		expect(md).toContain("补回归测试");
		expect(md).toContain("已证伪");
	});

	it("累计 token 过阈值后写盘（文件 + DB 双份）", () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId, {
			budgetTokens: 1e9,
			sessionMemoryStartTokens: 100,
			sessionMemoryEveryTokens: 50,
		});
		sm.append(toolResult("r"), 120);
		expect(storage.readSessionMemory(taskId)).toContain("# Session Memory");
		const row = db.prepare("SELECT session_memory FROM sessions WHERE task_id = ?").get(taskId) as {
			session_memory: string | null;
		};
		expect(row.session_memory).toContain("# Session Memory");
	});

	it("archive 冻结窗口并落最终 Session Memory", () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId);
		sm.append(toolResult("r1"));
		sm.archive();
		const snap = sm.snapshot();
		expect(snap.recentWindow).toHaveLength(0);
		expect(snap.taskState.progress.stage).toBe("archived");
		expect(storage.readSessionMemory(taskId)).toContain("archived");
		expect(storage.read(taskId).some((r) => r.kind === "archive")).toBe(true);
	});
});

// ---------- 恢复：附加两级 ----------

describe("恢复：五步主链 + 账本对账 + 文件复读", () => {
	it("不传 ledger/readFile 时步序与 v1 完全一致（向后兼容）", async () => {
		const { db, taskId } = seed();
		const { sm } = manager(db, taskId);
		sm.append(toolResult("r1"));
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => "abc" });
		const ctx = await rb.rebuild();
		expect(ctx.steps).toEqual([
			"1:task_state",
			"2:early_summary",
			"3:recent_window",
			"4:replay_tool_results(1)",
			"5:commit_check(ok)",
		]);
		expect(ctx.transcriptCheck).toBeNull();
		expect(ctx.restoredFiles).toEqual([]);
	});

	it("账本对账：窗口为空（崩在落库前）→ 按账本尾部重建", async () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId);
		sm.append(toolResult("r1"));
		sm.append(toolResult("r2"));
		// 模拟崩溃：账本已写，但 sessions.recent_window 没落
		db.prepare("UPDATE sessions SET recent_window = '[]' WHERE task_id = ?").run(taskId);
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => "abc", ledger: storage });
		const ctx = await rb.rebuild();
		expect(ctx.transcriptCheck).toMatchObject({ verified: true, repaired: true });
		expect(ctx.recentWindow.map((m) => m.content)).toEqual(["r1", "r2"]);
		expect(ctx.steps).toContain("6:transcript_check(rebuilt)");
	});

	it("文件复读：按最近访问取最多 5 个，读不到跳过不阻断", async () => {
		const { db, taskId } = seed();
		const { sm, storage } = manager(db, taskId);
		sm.append(toolResult(JSON.stringify({ path: "src/a.ts", bytes: 10 }), "read_file"));
		sm.append(toolResult(JSON.stringify({ path: "src/gone.ts", bytes: 10 }), "read_file"));
		const rb = new RecoveryBuilder(sm, {
			readHeadCommit: () => "abc",
			ledger: storage,
			readFile: (p) => (p === "src/a.ts" ? "export const a = 1;" : null),
		});
		const ctx = await rb.rebuild();
		expect(ctx.restoredFiles).toHaveLength(1);
		expect(ctx.restoredFiles[0]?.path).toBe("src/a.ts");
		expect(ctx.steps).toContain("7:restore_files(1)");
	});
});

// ---------- 工具函数 ----------

describe("工具函数", () => {
	it("defaultSummarize 确定性输出，含已外置/Snip 计数", () => {
		const out = defaultSummarize(null, [
			{ ...toolResult("x"), ref: "artifact:t/abc" },
			{ ...toolResult("y"), cleared: true },
		]);
		expect(out).toContain("已移出窗口的 2 条");
		expect(out).toContain("已外置：1 条");
		expect(out).toContain("已 Snip：1 条");
	});

	it("truncateMiddle 幂等且保留头尾", () => {
		const text = `${"H".repeat(100)}${"M".repeat(1000)}${"T".repeat(100)}`;
		const cut = truncateMiddle(text, 300);
		expect(cut.length).toBeLessThan(text.length);
		expect(cut.startsWith("H")).toBe(true);
		expect(cut).toContain("[truncated");
		expect(truncateMiddle(cut, 10_000)).toBe(cut); // 已短于阈值 → 原样返回
	});
});
