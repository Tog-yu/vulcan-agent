/**
 * 会话三层短期记忆（DEV_SPEC §14 P3-4，技术方案 5.2）。
 *
 * 三层分工（sessions 表，v1 迁移已建）：
 *   - task_state    结构化任务状态 JSON（恒定 ~2K tokens）——恢复时优先读，
 *                   回答"现在在哪、下一步做什么"；与摘要冲突时以 task_state 为准
 *   - recent_window 近期对话原文 JSON（滚动窗口，~60-80K tokens）——恢复后细读，
 *                   避免重做已做过的搜索
 *   - early_summary 早期摘要（增量重写，~10-15K tokens）——"之前发生过什么"的结论
 *
 * 摘要触发规则：每 K 步（默认 15）或累计输入达 Token 预算 60% → 增量摘要；
 * 触发后更早的原文移出窗口。摘要器由 deps.summarize 注入（生产=主模型调用，
 * 测试=确定性函数），本模块不依赖真实模型。
 *
 * 生命周期：短期记忆只随任务存在，任务结束归档为过程记录，不自动回流后续任务上下文。
 */

import type { DatabaseSync } from "node:sqlite";

// ---------- 类型 ----------

/** 结构化任务状态（技术方案 5.2 建议字段，恒定 ~2K tokens） */
export interface TaskState {
	task_id: string;
	trace_id?: string;
	objective: {
		issue: string;
		ticket_id?: string;
		acceptance_criteria: string[];
		constraints: {
			allow_api_change: boolean;
			allowed_repos: string[];
			forbidden: string[];
		};
	};
	progress: {
		stage: string;
		steps_done: string[];
		last_action: string;
		waiting_on: string | null;
	};
	context: {
		base_commit: string | null;
		branch: string | null;
		patch_ref: string[];
		open_questions: string[];
	};
	assumptions: Array<{ id: string; text: string; status: "unverified" | "verified" | "refuted"; evidence?: string }>;
	todos: string[];
	budget: { tokens_used: number; cost_usd: number; deadline: number | null };
}

/** 会话消息（滚动窗口最小单元） */
export interface SessionMessage {
	role: "user" | "assistant" | "toolResult";
	/** 正文（user/assistant）或 JSON 序列化结果（toolResult） */
	content: string;
	/** toolResult 关联的工具名 */
	toolName?: string;
	timestamp: number;
}

export interface SessionManagerDeps {
	/**
	 * 增量摘要器：输入早期摘要（可空）+ 移出窗口的原文，输出新摘要。
	 * 生产=主模型调用；测试=确定性函数。
	 */
	summarize: (earlySummary: string | null, evicted: SessionMessage[]) => string;
	/** Token 预算（60% 触发判定的分母） */
	budgetTokens: number;
	/** 摘要触发步数阈值（默认 15） */
	summaryStepInterval?: number;
	/** Token 预算触发占比（默认 0.6） */
	summaryTokenRatio?: number;
}

export interface SessionSnapshot {
	taskState: TaskState;
	recentWindow: SessionMessage[];
	earlySummary: string | null;
}

// ---------- 估算 ----------

/** 粗估 token 数（~4 字符/token，够触发判定用，不追求精确分词） */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ---------- 实现 ----------

export class SessionManager {
	private readonly deps: SessionManagerDeps;
	private readonly db: DatabaseSync;
	private readonly taskId: string;
	private sessionId: string | null = null;

	/** 步数计数（触发判定用） */
	private stepCount = 0;
	/** 累计输入 tokens */
	private inputTokens = 0;
	/** 滚动窗口 token 上限（超出即强制挤出，默认 70K，取 60-80K 中值） */
	private readonly windowTokenLimit = 70_000;

	constructor(db: DatabaseSync, taskId: string, deps: SessionManagerDeps) {
		this.db = db;
		this.taskId = taskId;
		this.deps = deps;
	}

	/** 取或建会话行 */
	private ensureSession(): string {
		if (this.sessionId) return this.sessionId;
		const existing = this.db.prepare("SELECT id FROM sessions WHERE task_id = ?").get(this.taskId) as
			| { id: string }
			| undefined;
		if (existing) {
			this.sessionId = existing.id;
			return existing.id;
		}
		// 初始 task_state 骨架
		const initial: TaskState = {
			task_id: this.taskId,
			objective: { issue: "", acceptance_criteria: [], constraints: { allow_api_change: false, allowed_repos: [], forbidden: [] } },
			progress: { stage: "started", steps_done: [], last_action: "", waiting_on: null },
			context: { base_commit: null, branch: null, patch_ref: [], open_questions: [] },
			assumptions: [],
			todos: [],
			budget: { tokens_used: 0, cost_usd: 0, deadline: null },
		};
		this.db
			.prepare("INSERT INTO sessions (id, task_id, task_state, recent_window) VALUES (?, ?, ?, ?)")
			.run(`sess-${this.taskId}`, this.taskId, JSON.stringify(initial), "[]");
		this.sessionId = `sess-${this.taskId}`;
		return this.sessionId;
	}

	/** 读当前快照（三层全量） */
	snapshot(): SessionSnapshot {
		const id = this.ensureSession();
		const row = this.db.prepare("SELECT task_state, recent_window, early_summary FROM sessions WHERE id = ?").get(id) as {
			task_state: string;
			recent_window: string;
			early_summary: string | null;
		};
		return {
			taskState: JSON.parse(row.task_state) as TaskState,
			recentWindow: JSON.parse(row.recent_window) as SessionMessage[],
			earlySummary: row.early_summary,
		};
	}

	/** 读 task_state（冲突裁定的权威层） */
	getTaskState(): TaskState {
		return this.snapshot().taskState;
	}

	/** 写 task_state（恒定层，整对象替换） */
	setTaskState(next: TaskState): void {
		const id = this.ensureSession();
		this.db.prepare("UPDATE sessions SET task_state = ? WHERE id = ?").run(JSON.stringify(next), id);
	}

	/**
	 * 追加一条消息到滚动窗口，并执行摘要触发判定。
	 * @param inputTokens 本步新增输入 tokens（调用方从 usage 上报）
	 */
	append(msg: SessionMessage, inputTokens = 0): { summaryTriggered: boolean } {
		const id = this.ensureSession();
		this.stepCount += 1;
		this.inputTokens += inputTokens;

		const snap = this.snapshot();
		snap.recentWindow.push(msg);

		// 预算上报同步进 task_state.budget
		snap.taskState.budget.tokens_used = this.inputTokens;

		// —— 触发判定：K 步或 Token 预算 60% ——
		const stepInterval = this.deps.summaryStepInterval ?? 15;
		const stepHit = this.stepCount % stepInterval === 0;
		const tokenHit = this.inputTokens >= this.deps.budgetTokens * (this.deps.summaryTokenRatio ?? 0.6);
		let summaryTriggered = false;

		if (stepHit || tokenHit) {
			summaryTriggered = true;
			// 摘要只针对移出窗口的部分：保留最近 10 条原文，更早的进摘要
			const keep = 10;
			const evicted = snap.recentWindow.slice(0, Math.max(0, snap.recentWindow.length - keep));
			if (evicted.length > 0) {
				snap.earlySummary = this.deps.summarize(snap.earlySummary, evicted);
				snap.recentWindow = snap.recentWindow.slice(Math.max(0, snap.recentWindow.length - keep));
			}
		}

		// —— 窗口硬上限：超限从头部挤出（无摘要合并，仅保底防膨胀）——
		while (snap.recentWindow.length > 1 && snap.recentWindow.reduce((n, m) => n + estimateTokens(m.content), 0) > this.windowTokenLimit) {
			snap.recentWindow.shift();
		}

		this.db
			.prepare("UPDATE sessions SET task_state = ?, recent_window = ?, early_summary = ? WHERE id = ?")
			.run(JSON.stringify(snap.taskState), JSON.stringify(snap.recentWindow), snap.earlySummary, id);
		return { summaryTriggered };
	}

	/** 取最近 N 条工具结果（中断恢复 P3-5 用：重放最近 3 条工具调用结果） */
	recentToolResults(n: number): SessionMessage[] {
		return this.snapshot()
			.recentWindow.filter((m) => m.role === "toolResult")
			.slice(-n);
	}

	/** 任务结束归档：短期记忆冻结为过程记录，不自动回流后续任务上下文 */
	archive(): void {
		const id = this.ensureSession();
		const state = this.getTaskState();
		this.db
			.prepare("UPDATE sessions SET task_state = ?, recent_window = ? WHERE id = ?")
			.run(JSON.stringify({ ...state, progress: { ...state.progress, stage: "archived" } }), "[]", id);
	}
}
