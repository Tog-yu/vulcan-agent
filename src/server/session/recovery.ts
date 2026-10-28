/**
 * 中断恢复（v2：五步主链 + 两级附加校验）。
 *
 * 主链（保持 v1 顺序与命名，向后兼容）：
 *   1. 读结构化任务状态（task_state）—— 权威层，立刻知道当前阶段与约束
 *   2. 读早期摘要（early_summary）/ Session Memory —— 知道试过什么、排除了什么
 *   3. 读近期对话原文（recent_window）—— 补齐细节，避免重复劳动
 *   4. 重放最近 3 条工具调用结果（不重新执行）—— 环境与中断前一致
 *   5. 重新校验 base_commit —— 中断期间可能有人合入；不一致则对齐分支
 *
 * 附加校验（对照 Claude Code 的 Transcript 重建 + readFileState 复读，传了才启用）：
 *   6. transcript_check —— 与 JSONL 账本对账；窗口丢失（崩在落库前）则按账本重建
 *   7. restore_files —— 按最近访问复读最多 5 个文件（每文件 ≤5K、总 ≤50K tokens）
 *
 * 重试耗尽（默认 3 次）→ 任务转 failed（由编排层执行，本模块只返回判定）。
 */

import type { SessionManager, SessionMessage, TaskState } from "../session/index.ts";
import type { FileAccessEntry, SessionStorage, TranscriptRecord } from "../session/types.ts";
import { estimateTokens, SESSION_DEFAULTS } from "../session/types.ts";

export interface RestoredFile {
	path: string;
	content: string;
	tokens: number;
}

/** 五步重建的产出：可直接作为 AgentLoop 的恢复上下文 */
export interface RecoveredContext {
	/** 步骤 1：结构化任务状态（权威层） */
	taskState: TaskState;
	/** 步骤 2：早期摘要（可 null = 无早期内容） */
	earlySummary: string | null;
	/** 步骤 2 补充：Session Memory 结构化笔记（可 null） */
	sessionMemory: string | null;
	/** 步骤 3：近期对话原文 */
	recentWindow: SessionMessage[];
	/** 步骤 4：重放的最近 3 条工具结果（不重新执行，仅注入上下文） */
	replayedToolResults: SessionMessage[];
	/** 步骤 5：base_commit 校验结果与对齐动作 */
	commitCheck: {
		expected: string | null;
		actual: string | null;
		/** true = 校验通过或无需校验；false = 已尝试重新对齐 */
		aligned: boolean;
		/** 重新对齐后的新 commit（aligned 时才可能有值） */
		realignedTo: string | null;
	};
	/** 步骤 6：账本对账结果（未传 ledger 时 null） */
	transcriptCheck: {
		/** 账本是否可用且与窗口一致 */
		verified: boolean;
		/** 账本最后一条序号 */
		ledgerSeq: number;
		/** 是否按账本重建了窗口（崩在落库前的情形） */
		repaired: boolean;
	} | null;
	/** 步骤 7：复读的文件（未启用时空数组） */
	restoredFiles: RestoredFile[];
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
	/** JSONL 账本（传了才做第 6 步对账/重建） */
	ledger?: SessionStorage;
	/** 读文件内容（传了才做第 7 步复读；测试注入，生产用 fs） */
	readFile?: (path: string) => string | null;
}

/** 账本记录 → 窗口消息（只取有正文的三类） */
function toMessage(rec: TranscriptRecord): SessionMessage | null {
	if (rec.kind !== "user" && rec.kind !== "assistant" && rec.kind !== "tool_result") return null;
	const content = typeof rec.payload === "string" ? rec.payload : JSON.stringify(rec.payload ?? "");
	return {
		role: rec.kind === "tool_result" ? "toolResult" : rec.kind,
		content,
		toolName: rec.tool_name,
		timestamp: rec.ts,
		ref: rec.ref,
	};
}

export class RecoveryBuilder {
	private readonly session: SessionManager;
	private readonly deps: RecoveryDeps;

	constructor(session: SessionManager, deps: RecoveryDeps) {
		this.session = session;
		this.deps = deps;
	}

	/** 五步主链 + 可选附加校验。任一步失败即抛错（带步号），不让恢复半途静默降级 */
	async rebuild(): Promise<RecoveredContext> {
		const steps: string[] = [];

		// —— 步骤 1：结构化任务状态（权威层，冲突时以此为准）——
		const taskState = this.session.getTaskState();
		steps.push("1:task_state");

		// —— 步骤 2：早期摘要 + Session Memory ——
		const snap = this.session.snapshot();
		const earlySummary = snap.earlySummary;
		const sessionMemory = this.session.readSessionMemory();
		steps.push("2:early_summary");

		// —— 步骤 3：近期对话原文 ——
		let recentWindow = snap.recentWindow;
		steps.push("3:recent_window");

		// —— 步骤 4：重放最近 3 条工具结果（不重新执行）——
		const replayedToolResults = this.session.recentToolResults(SESSION_DEFAULTS.replayToolResults);
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
				if (!this.deps.realignBranch) {
					throw new Error("VULCAN_RECOVERY_002: base_commit 不一致且未提供 re-align 能力");
				}
				realignedTo = await this.deps.realignBranch(taskState.context.branch, expected);
				if (realignedTo === null) {
					throw new Error("VULCAN_RECOVERY_003: 重新对齐分支失败");
				}
				aligned = false;
				this.session.setTaskState({
					...taskState,
					context: { ...taskState.context, base_commit: realignedTo },
				});
			}
		}
		steps.push(`5:commit_check(${aligned ? "ok" : "realigned"})`);

		// —— 步骤 6（可选）：账本对账 —— 崩在落库前时窗口会落后于账本
		let transcriptCheck: RecoveredContext["transcriptCheck"] = null;
		if (this.deps.ledger) {
			const records = this.deps.ledger.read(taskState.task_id);
			const ledgerSeq = records.length > 0 ? (records[records.length - 1]?.seq ?? 0) : 0;
			let repaired = false;
			if (recentWindow.length === 0 && ledgerSeq > 0) {
				// 窗口为空（崩溃时 UPDATE 未执行）→ 按账本尾部重建
				const rebuilt = records
					.map(toMessage)
					.filter((m): m is SessionMessage => m !== null)
					.slice(-SESSION_DEFAULTS.keepRecent);
				if (rebuilt.length > 0) {
					recentWindow = rebuilt;
					repaired = true;
				}
			}
			transcriptCheck = { verified: true, ledgerSeq, repaired };
			steps.push(`6:transcript_check(${repaired ? "rebuilt" : "ok"})`);
		}

		// —— 步骤 7（可选）：按最近访问复读文件（压缩/中断后的文件上下文恢复）——
		const restoredFiles: RestoredFile[] = [];
		if (this.deps.readFile) {
			const entries = this.session
				.getFileState()
				.sort((a, b) => b.last_access - a.last_access)
				.slice(0, SESSION_DEFAULTS.restoreFilesMax);
			let budget = SESSION_DEFAULTS.restoreTotalTokenCap;
			for (const e of entries) {
				if (budget <= 0) break;
				const content = this.deps.readFile(e.path);
				if (content === null) continue; // 文件被删/不可读 → 跳过，不阻断恢复
				const cap = Math.min(SESSION_DEFAULTS.restoreFileTokenCap, budget);
				const trimmed = content.length > cap * 4 ? content.slice(0, cap * 4) : content;
				const tokens = estimateTokens(trimmed);
				budget -= tokens;
				restoredFiles.push({ path: e.path, content: trimmed, tokens });
			}
			steps.push(`7:restore_files(${restoredFiles.length})`);
		}

		return {
			taskState,
			earlySummary,
			sessionMemory,
			recentWindow,
			replayedToolResults,
			commitCheck: { expected, actual, aligned, realignedTo },
			transcriptCheck,
			restoredFiles,
			steps,
		};
	}

	/** 重试是否耗尽（编排层据此决定任务转 failed） */
	isRetryExhausted(attempt: number): boolean {
		return attempt >= (this.deps.maxRetries ?? 3);
	}
}

/** 文件访问台账的便捷推导：给编排层拼 restore 预算用 */
export function pickRestoreTargets(
	entries: FileAccessEntry[],
	max = SESSION_DEFAULTS.restoreFilesMax,
): FileAccessEntry[] {
	return entries
		.filter((e) => e.mode === "read")
		.sort((a, b) => b.last_access - a.last_access)
		.slice(0, max);
}
