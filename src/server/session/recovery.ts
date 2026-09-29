/**
 * 中断恢复五步重建（DEV_SPEC §14 P3-5，技术方案 5.3）。
 *
 * 恢复按固定顺序重建，不试图一次性还原全部历史：
 *   1. 读结构化任务状态（task_state）—— 立刻知道当前阶段与约束
 *   2. 读早期摘要（early_summary）—— 知道之前试过什么、排除了什么
 *   3. 读近期对话原文（recent_window）—— 补齐细节，避免重复劳动
 *   4. 重放最近 3 条工具调用结果（不重新执行）—— 确保模型看到的环境与中断前一致
 *   5. 重新校验 base_commit —— 中断期间可能有人合入；校验不通过重新对齐分支再继续
 *
 * 重试耗尽（默认 3 次）→ 任务转 failed（由编排层执行，本模块只返回判定）。
 */

import type { SessionManager, TaskState } from "../session/index.ts";

/** 五步重建的产出：可直接作为 AgentLoop 的恢复上下文 */
export interface RecoveredContext {
	/** 步骤 1：结构化任务状态（权威层） */
	taskState: TaskState;
	/** 步骤 2：早期摘要（可 null = 无早期内容） */
	earlySummary: string | null;
	/** 步骤 3：近期对话原文 */
	recentWindow: Awaited<ReturnType<SessionManager["snapshot"]>>["recentWindow"];
	/** 步骤 4：重放的最近 3 条工具结果（不重新执行，仅注入上下文） */
	replayedToolResults: Awaited<ReturnType<SessionManager["recentToolResults"]>>;
	/** 步骤 5：base_commit 校验结果与对齐动作 */
	commitCheck: {
		expected: string | null;
		actual: string | null;
		/** true = 校验通过或无需校验；false = 已尝试重新对齐 */
		aligned: boolean;
		/** 重新对齐后的新 commit（aligned 时才可能有值） */
		realignedTo: string | null;
	};
	/** 恢复过程日志（trace 完整性用） */
	steps: string[];
}

export interface RecoveryDeps {
	/**
	 * 读当前 HEAD commit（普通项目=git rev-parse；测试=注入）。
	 * 返回 null = 无法读取（仓库不可用）。
	 */
	readHeadCommit: (branch: string | null) => Promise<string | null> | string | null;
	/**
	 * 重新对齐分支（base_commit 校验失败时）。
	 * 生产=rebase/merge 远端分支；返回对齐后的新 commit，null=对齐失败。
	 */
	realignBranch?: (branch: string | null, expectedBase: string | null) => Promise<string | null> | string | null;
	/** 重试上限（默认 3），耗尽后 isRetryExhausted 返回 true */
	maxRetries?: number;
}

export class RecoveryBuilder {
	constructor(
		private readonly session: SessionManager,
		private readonly deps: RecoveryDeps,
	) {}

	/** 五步顺序重建。任一步失败即抛错（带步号），不让恢复半途静默降级 */
	async rebuild(): Promise<RecoveredContext> {
		const steps: string[] = [];

		// —— 步骤 1：结构化任务状态（权威层，冲突时以此为准）——
		const taskState = this.session.getTaskState();
		steps.push("1:task_state");

		// —— 步骤 2：早期摘要 ——
		const snap = this.session.snapshot();
		const earlySummary = snap.earlySummary;
		steps.push("2:early_summary");

		// —— 步骤 3：近期对话原文 ——
		const recentWindow = snap.recentWindow;
		steps.push("3:recent_window");

		// —— 步骤 4：重放最近 3 条工具结果（不重新执行）——
		const replayedToolResults = this.session.recentToolResults(3);
		steps.push(`4:replay_tool_results(${replayedToolResults.length})`);

		// —— 步骤 5：重新校验 base_commit ——
		const expected = taskState.context.base_commit;
		let actual: string | null = null;
		let aligned = true;
		let realignedTo: string | null = null;
		if (expected !== null) {
			actual = await this.deps.readHeadCommit(taskState.context.branch);
			if (actual === null) {
				throw new Error("VULCAN_RECOVERY_001: 恢复步骤5失败——无法读取当前 HEAD commit");
			}
			if (actual !== expected) {
				// 中断期间有人合入 → 重新对齐分支再继续
				if (!this.deps.realignBranch) {
					throw new Error("VULCAN_RECOVERY_002: base_commit 不一致且未提供 re-align 能力");
				}
				realignedTo = await this.deps.realignBranch(taskState.context.branch, expected);
				if (realignedTo === null) {
					throw new Error("VULCAN_RECOVERY_003: 重新对齐分支失败");
				}
				aligned = false;
				// 对齐成功：task_state 的 base_commit 同步更新（权威层记录新坐标）
				this.session.setTaskState({
					...taskState,
					context: { ...taskState.context, base_commit: realignedTo },
				});
			}
		}
		steps.push(`5:commit_check(${aligned ? "ok" : "realigned"})`);

		return { taskState, earlySummary, recentWindow, replayedToolResults, commitCheck: { expected, actual, aligned, realignedTo }, steps };
	}

	/** 重试是否耗尽（编排层据此决定任务转 failed） */
	isRetryExhausted(attempt: number): boolean {
		return attempt >= (this.deps.maxRetries ?? 3);
	}
}
