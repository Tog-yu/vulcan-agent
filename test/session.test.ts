import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import {
	SessionManager,
	estimateTokens,
	type SessionMessage,
	type TaskState,
} from "../src/server/session/index.ts";

function seed(taskId = "t-1"): { db: DatabaseSync; taskId: string } {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, 'alert', 'fp-1', 'running', 0, 0)",
	).run(taskId);
	return { db, taskId };
}

function msg(role: SessionMessage["role"], content: string, toolName?: string): SessionMessage {
	return { role, content, toolName, timestamp: Date.now() };
}

function manager(db: DatabaseSync, taskId: string, opts?: Partial<ConstructorParameters<typeof SessionManager>[2]>) {
	return new SessionManager(db, taskId, {
		summarize: (early, evicted) => `${early ?? ""}[摘要+${evicted.length}条]`,
		budgetTokens: 1000,
		...opts,
	});
}

describe("P3-4 session 三层短期记忆", () => {
	it("初始化：首次访问创建骨架 task_state（恒定层）", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId);
		const state = sm.getTaskState();
		expect(state.task_id).toBe(taskId);
		expect(state.progress.stage).toBe("started");
		expect(state.objective.constraints.allowed_repos).toEqual([]);
		expect(state.budget.tokens_used).toBe(0);
	});

	it("三层分工：消息进滚动窗口，task_state 整体替换，摘要独立", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId);
		sm.append(msg("user", "fix the login bug"));
		sm.append(msg("toolResult", "file content here", "read_file"));
		const snap = sm.snapshot();
		expect(snap.recentWindow).toHaveLength(2);
		expect(snap.earlySummary).toBeNull();
		// task_state 是结构化对象，不是聊天记录
		expect(snap.taskState.progress.steps_done).toEqual([]);
	});

	it("K 步触发：第 15 步触发增量摘要，早期原文移出窗口", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId, { summaryStepInterval: 15 });
		let triggered = false;
		for (let i = 0; i < 15; i++) {
			({ summaryTriggered: triggered } = sm.append(msg("assistant", `step ${i}`)));
		}
		expect(triggered).toBe(true);
		const snap = sm.snapshot();
		expect(snap.earlySummary).toBe("[摘要+5条]"); // 15 条 - 保留 10 条 = 5 条进摘要
		expect(snap.recentWindow).toHaveLength(10);
	});

	it("Token 60% 预算触发：累计输入达预算 60% 即摘要（不等步数）", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId, { budgetTokens: 1000 }); // 60% = 600
		let triggered = false;
		// 每步 100 tokens，第 6 步达 600
		for (let i = 0; i < 6; i++) {
			({ summaryTriggered: triggered } = sm.append(msg("assistant", "x"), 100));
		}
		expect(triggered).toBe(true);
		const snap = sm.snapshot();
		// 窗口仅 6 条 < keep 10，无移出条目 → 不调摘要器，earlySummary 保持 null
		expect(snap.earlySummary).toBeNull();
		expect(snap.taskState.budget.tokens_used).toBe(600);
	});

	it("增量重写：新摘要基于旧摘要（不丢早期结论）", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId, { summaryStepInterval: 12, budgetTokens: 1_000_000 });
		for (let i = 0; i < 12; i++) sm.append(msg("assistant", "a")); // 第一次触发：12-10=2 条进摘要
		for (let i = 0; i < 12; i++) sm.append(msg("assistant", "b")); // 第二次触发：窗口 10+12=22，22-10=12 条进摘要
		const snap = sm.snapshot();
		// 第二次摘要 = 旧摘要 + 新移出条目（12 条）
		expect(snap.earlySummary).toBe("[摘要+2条][摘要+12条]");
	});

	it("冲突裁定：task_state 与摘要不一致时以 task_state 为准（摘要不回写 task_state）", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId);
		// 摘要器输出任何内容都不会改 task_state.progress
		sm.append(msg("assistant", "x"), 999);
		const state = sm.getTaskState();
		expect(state.progress.stage).toBe("started"); // 只有显式 setTaskState 才会改
		// 显式更新后 authority 翻转
		const next: TaskState = { ...state, progress: { ...state.progress, stage: "locating" } };
		sm.setTaskState(next);
		expect(sm.getTaskState().progress.stage).toBe("locating");
	});

	it("recentToolResults：取最近 N 条工具结果（供 P3-5 重放）", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId);
		sm.append(msg("assistant", "call 1"));
		sm.append(msg("toolResult", "r1", "read_file"));
		sm.append(msg("assistant", "call 2"));
		sm.append(msg("toolResult", "r2", "search_code"));
		sm.append(msg("toolResult", "r3", "read_file"));
		const recent = sm.recentToolResults(2);
		expect(recent.map((m) => m.toolName)).toEqual(["search_code", "read_file"]);
	});

	it("archive：任务结束冻结窗口，stage 标记 archived，不自动回流", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId);
		sm.append(msg("toolResult", "r", "read_file"));
		sm.archive();
		const snap = sm.snapshot();
		expect(snap.recentWindow).toHaveLength(0); // 原文清空（归档为过程记录）
		expect(snap.taskState.progress.stage).toBe("archived");
	});

	it("窗口硬上限：超 70K tokens 从头部挤出，不崩溃", () => {
		const { db, taskId } = seed();
		const sm = manager(db, taskId, { budgetTokens: 1e9 });
		const big = "x".repeat(200_000); // ~50K tokens
		sm.append(msg("assistant", big));
		sm.append(msg("assistant", big));
		const snap = sm.snapshot();
		expect(snap.recentWindow.length).toBeLessThan(2); // 挤出保底生效
	});

	it("estimateTokens 粗估可用", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("a".repeat(401))).toBe(101);
	});
});
