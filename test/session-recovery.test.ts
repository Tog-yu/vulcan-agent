import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { SessionManager, type SessionMessage } from "../src/server/session/index.ts";
import { RecoveryBuilder } from "../src/server/session/recovery.ts";

function seed(taskId = "t-rec"): { db: DatabaseSync; sm: SessionManager; taskId: string } {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, 'alert', 'fp-1', 'running', 0, 0)",
	).run(taskId);
	const sm = new SessionManager(db, taskId, {
		summarize: (early, evicted) => `${early ?? ""}[摘要+${evicted.length}条]`,
		budgetTokens: 1_000_000,
	});
	return { db, sm, taskId };
}

function toolResult(content: string): SessionMessage {
	return { role: "toolResult", content, toolName: "read_file", timestamp: Date.now() };
}

async function preparedSession(taskId = "t-rec") {
	const { db, sm, taskId: id } = seed(taskId);
	// 预置：base_commit + 3 条以上工具结果 + task_state 更新
	const state = sm.getTaskState();
	sm.setTaskState({
		...state,
		progress: { ...state.progress, stage: "locating", steps_done: ["search", "read"] },
		context: { ...state.context, base_commit: "abc1234", branch: "fix/login" },
	});
	sm.append({ role: "assistant", content: "reading file", timestamp: Date.now() });
	sm.append(toolResult("r1"));
	sm.append(toolResult("r2"));
	sm.append(toolResult("r3"));
	sm.append(toolResult("r4"));
	return { db, sm, taskId: id, state: sm.getTaskState() };
}

describe("P3-5 中断恢复五步重建", () => {
	it("五步顺序执行：task_state → early_summary → recent_window → 重放3条工具结果 → commit 校验", async () => {
		const { sm } = await preparedSession();
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => "abc1234" });
		const ctx = await rb.rebuild();
		expect(ctx.steps).toEqual([
			"1:task_state",
			"2:early_summary",
			"3:recent_window",
			"4:replay_tool_results(3)",
			"5:commit_check(ok)",
		]);
		// 步骤 1：权威层还原
		expect(ctx.taskState.progress.stage).toBe("locating");
		expect(ctx.taskState.context.base_commit).toBe("abc1234");
		// 步骤 4：只重放最近 3 条（r2/r3/r4），不重新执行
		expect(ctx.replayedToolResults.map((m) => m.content)).toEqual(["r2", "r3", "r4"]);
		// 步骤 5：一致 → aligned
		expect(ctx.commitCheck).toMatchObject({ expected: "abc1234", actual: "abc1234", aligned: true, realignedTo: null });
	});

	it("base_commit 校验失败 → 重新对齐分支，task_state 更新为新坐标", async () => {
		const { sm } = await preparedSession();
		const rb = new RecoveryBuilder(sm, {
			readHeadCommit: () => "def5678", // 中断期间有人合入
			realignBranch: (_branch, expectedBase) => `realigned-from-${expectedBase}`,
		});
		const ctx = await rb.rebuild();
		expect(ctx.commitCheck.aligned).toBe(false);
		expect(ctx.commitCheck.realignedTo).toBe("realigned-from-abc1234");
		// 权威层同步新坐标（恢复后续步骤用新 commit）
		expect(sm.getTaskState().context.base_commit).toBe("realigned-from-abc1234");
		expect(ctx.steps[4]).toBe("5:commit_check(realigned)");
	});

	it("对齐失败（realignBranch 返回 null）→ 抛错不静默降级", async () => {
		const { sm } = await preparedSession();
		const rb = new RecoveryBuilder(sm, {
			readHeadCommit: () => "def5678",
			realignBranch: () => null,
		});
		await expect(rb.rebuild()).rejects.toThrow(/VULCAN_RECOVERY_003/);
	});

	it("无法读 HEAD → 抛错（步骤 5 失败）", async () => {
		const { sm } = await preparedSession();
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => null });
		await expect(rb.rebuild()).rejects.toThrow(/VULCAN_RECOVERY_001/);
	});

	it("base_commit 为 null（任务未定基）→ 跳过校验不算失败", async () => {
		const { db, sm, taskId } = seed();
		sm.setTaskState({ ...sm.getTaskState(), context: { ...sm.getTaskState().context, base_commit: null } });
		const rb = new RecoveryBuilder(sm, {
			readHeadCommit: () => {
				throw new Error("should not be called");
			},
		});
		const ctx = await rb.rebuild();
		expect(ctx.commitCheck.aligned).toBe(true);
		expect(ctx.commitCheck.expected).toBeNull();
		void db;
		void taskId;
	});

	it("重试计数：默认 3 次耗尽判定", async () => {
		const { sm } = await preparedSession();
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => "abc1234" });
		expect(rb.isRetryExhausted(1)).toBe(false);
		expect(rb.isRetryExhausted(2)).toBe(false);
		expect(rb.isRetryExhausted(3)).toBe(true);
	});

	it("空会话恢复：三层全空也不崩溃（最小现场）", async () => {
		const { sm } = seed("t-empty");
		const rb = new RecoveryBuilder(sm, { readHeadCommit: () => "abc" });
		const ctx = await rb.rebuild();
		expect(ctx.recentWindow).toHaveLength(0);
		expect(ctx.replayedToolResults).toHaveLength(0);
		expect(ctx.earlySummary).toBeNull();
	});
});
