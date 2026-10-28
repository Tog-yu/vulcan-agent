/**
 * 会话短期记忆（v2，对照 Claude Code 记忆体系重构）。
 *
 * 三层分工（sessions 表，一行 = 一个 task）：
 *   - task_state    结构化任务状态 JSON（恒定 ~2K tokens）——权威层，恢复时先读，
 *                   与摘要冲突时以它为准；压缩只作用在 window/summary，永不裁它
 *   - recent_window 近期对话原文 JSON（滚动窗口，硬上限 windowTokenLimit）
 *   - early_summary 增量摘要（每次触发在被挤出内容上重写，不丢早期结论）
 *
 * v2 新增（对应 CC 的 Transcript + 四层压缩）：
 *   - SessionStorage：Transcript JSONL 账本（append-only，可恢复/回放/审计）
 *   - L1 Snip / L2 外置 / L4 硬预算：见 compact.ts
 *   - Session Memory：结构化笔记文件，L3 的零 LLM 摘要源
 *   - fileState：记录读过/写过的文件，恢复时复读最新内容
 *   - compactMeta：压缩动作与熔断状态（可观测）
 */

import type { DatabaseSync } from "node:sqlite";
import {
	defaultSummarize,
	enforceWindowLimit,
	externalizeLargeToolResults,
	renderSessionMemory,
	snipOldToolResults,
	tuning,
	windowTokens,
} from "./compact.ts";
import type { CompactMeta, FileAccessEntry, SessionMessage, SessionStorage, TaskState } from "./types.ts";
import { estimateTokens, initialCompactMeta, initialTaskState, SESSION_DEFAULTS } from "./types.ts";

export type { CompactMeta, FileAccessEntry, SessionMessage, SessionStorage, TaskState } from "./types.ts";
export { CLEARABLE_TOOLS, estimateTokens, initialTaskState, PROTECTED_TOOLS, SESSION_DEFAULTS } from "./types.ts";

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
	/** 滚动窗口 token 上限（默认 70K） */
	windowTokenLimit?: number;
	/** L1 保留的最近工具结果条数（默认 6） */
	snipKeepRecentToolResults?: number;
	/** L2 单条外置阈值（默认 8K tokens） */
	externalizeThresholdTokens?: number;
	/** 账本 + 外置 + Session Memory 落盘；不传 = 纯内存快照（测试/无状态场景） */
	storage?: SessionStorage;
	/** Session Memory 启动阈值 / 更新间隔（tokens） */
	sessionMemoryStartTokens?: number;
	sessionMemoryEveryTokens?: number;
}

export interface SessionSnapshot {
	taskState: TaskState;
	recentWindow: SessionMessage[];
	earlySummary: string | null;
	compactMeta: CompactMeta;
}

interface SessionRow {
	task_state: string;
	recent_window: string;
	early_summary: string | null;
	compact_meta: string | null;
	file_state: string | null;
	session_memory: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
	if (!text) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

export class SessionManager {
	private readonly deps: SessionManagerDeps;
	private readonly db: DatabaseSync;
	private readonly taskId: string;
	private sessionId: string | null = null;

	/** 步数计数（触发判定用） */
	private stepCount = 0;
	/** 累计输入 tokens */
	private inputTokens = 0;
	/** 滚动窗口 token 上限 */
	private readonly windowTokenLimit: number;
	/** 上次写 Session Memory 时的 token 水位 */
	private lastMemoryAt = 0;

	constructor(db: DatabaseSync, taskId: string, deps: SessionManagerDeps) {
		this.db = db;
		this.taskId = taskId;
		this.deps = deps;
		this.windowTokenLimit = deps.windowTokenLimit ?? SESSION_DEFAULTS.windowTokenLimit;
	}

	private storage(): SessionStorage | null {
		return this.deps.storage ?? null;
	}

	private row(): SessionRow | null {
		const id = this.ensureSession();
		return (
			(this.db
				.prepare(
					"SELECT task_state, recent_window, early_summary, compact_meta, file_state, session_memory FROM sessions WHERE id = ?",
				)
				.get(id) as SessionRow | undefined) ?? null
		);
	}

	private ensureSession(): string {
		if (this.sessionId) return this.sessionId;
		const existing = this.db.prepare("SELECT id FROM sessions WHERE task_id = ?").get(this.taskId) as
			| { id: string }
			| undefined;
		if (existing) {
			this.sessionId = existing.id;
			return existing.id;
		}
		const initial = initialTaskState(this.taskId);
		this.db
			.prepare("INSERT INTO sessions (id, task_id, task_state, recent_window) VALUES (?, ?, ?, ?)")
			.run(`sess-${this.taskId}`, this.taskId, JSON.stringify(initial), "[]");
		this.sessionId = `sess-${this.taskId}`;
		return this.sessionId;
	}

	/** 读当前快照（三层全量 + 压缩元数据） */
	snapshot(): SessionSnapshot {
		const row = this.row();
		return {
			taskState: parseJson(row?.task_state ?? null, initialTaskState(this.taskId)),
			recentWindow: parseJson(row?.recent_window ?? null, [] as SessionMessage[]),
			earlySummary: row?.early_summary ?? null,
			compactMeta: parseJson(row?.compact_meta ?? null, initialCompactMeta()),
		};
	}

	/** 读 task_state（冲突裁定的权威层） */
	getTaskState(): TaskState {
		return this.snapshot().taskState;
	}

	/** 写 task_state（恒定层，整对象替换）+ 落一条 state_change 账本记录 */
	setTaskState(next: TaskState): void {
		const id = this.ensureSession();
		this.db.prepare("UPDATE sessions SET task_state = ? WHERE id = ?").run(JSON.stringify(next), id);
		this.storage()?.append(this.taskId, {
			ts: Date.now(),
			kind: "state_change",
			payload: { stage: next.progress.stage, base_commit: next.context.base_commit, todos: next.todos.length },
		});
	}

	/**
	 * 追加一条消息到滚动窗口，并执行四层压缩。
	 * @param inputTokens 本步新增输入 tokens（也可用 noteUsage 单独上报）
	 */
	append(msg: SessionMessage, inputTokens = 0): { summaryTriggered: boolean } {
		const snap = this.snapshot();
		const step = ++this.stepCount;
		this.inputTokens += inputTokens;

		// 账本：原始事实先落（不可变），再压缩窗口（可变快照）
		this.storage()?.append(this.taskId, {
			ts: msg.timestamp,
			kind: msg.role === "toolResult" ? "tool_result" : msg.role,
			tool_name: msg.toolName,
			payload: msg.content,
			tokens: estimateTokens(msg.content),
		});

		let window: SessionMessage[] = [...snap.recentWindow, { ...msg, step }];
		let summary = snap.earlySummary;
		const meta = snap.compactMeta;
		const t = tuning({
			snipKeepRecentToolResults: this.deps.snipKeepRecentToolResults,
			externalizeThresholdTokens: this.deps.externalizeThresholdTokens,
			windowTokenLimit: this.windowTokenLimit,
		});

		// —— L1 Snip：清旧只读工具结果（保留消息结构，不拆 tool_use/result 配对）——
		const snip = snipOldToolResults(window, t);
		window = snip.window;
		meta.snip_count += snip.snipped;

		// —— L2 外置：单条超阈值 → artifact + 指针 ——
		if (this.storage()) {
			const ext = externalizeLargeToolResults(window, this.storage() as SessionStorage, this.taskId, t);
			window = ext.window;
			meta.externalize_count += ext.externalized;
		}

		// —— L3 增量摘要：K 步或预算 60% ——
		const stepInterval = this.deps.summaryStepInterval ?? SESSION_DEFAULTS.summaryStepInterval;
		const stepHit = this.stepCount % stepInterval === 0;
		const tokenHit =
			this.inputTokens >= this.deps.budgetTokens * (this.deps.summaryTokenRatio ?? SESSION_DEFAULTS.summaryTokenRatio);
		let summaryTriggered = false;
		let reason: CompactMeta["last_reason"] = null;

		if (stepHit || tokenHit) {
			summaryTriggered = true;
			reason = stepHit ? "step" : "token";
			const keep = SESSION_DEFAULTS.keepRecent;
			const evicted = window.slice(0, Math.max(0, window.length - keep));
			if (evicted.length > 0) {
				summary = this.deps.summarize(summary, evicted);
				window = window.slice(Math.max(0, window.length - keep));
				meta.summary_count += 1;
				meta.last_step = this.stepCount;
				meta.last_reason = reason;
			}
		}

		// —— L4 硬预算：先外置最大、再 FIFO、最后截断 ——
		let evictedCount = 0;
		let truncated = false;
		if (this.storage()) {
			const limit = enforceWindowLimit(window, this.storage() as SessionStorage, this.taskId, t);
			window = limit.window;
			evictedCount = limit.evicted;
			meta.externalize_count += limit.externalized;
			truncated = limit.truncated;
		} else {
			// 无 storage 的降级路径：v1 行为（FIFO 保底）
			while (window.length > 1 && windowTokens(window) > this.windowTokenLimit) {
				window.shift();
				evictedCount += 1;
			}
		}
		meta.evicted_count += evictedCount;

		// 熔断：硬压缩后仍超（只可能是 storage 侧异常导致外置没生效）
		const oversized = windowTokens(window) > this.windowTokenLimit;
		if (oversized && window.length > 1) {
			meta.consecutive_failures += 1;
			if (meta.consecutive_failures >= SESSION_DEFAULTS.maxConsecutiveCompactFailures) {
				meta.fused = true;
				this.persist(snap.taskState, window, summary, meta);
				throw new Error("VULCAN_COMPACT_FUSED: 连续压缩失败达到熔断阈值，拒绝继续累积上下文");
			}
		} else {
			meta.consecutive_failures = 0;
		}

		// 预算上报进权威层
		snap.taskState.budget.tokens_used = this.inputTokens;
		this.persist(snap.taskState, window, summary, meta);

		// 压缩边界落账本（恢复与审计的关键锚点）
		if (summaryTriggered || snip.snipped > 0 || evictedCount > 0 || truncated) {
			this.storage()?.append(this.taskId, {
				ts: Date.now(),
				kind: "compact_boundary",
				payload: {
					window_tokens: windowTokens(window),
					window_items: window.length,
					snipped: snip.snipped,
					evicted: evictedCount,
					truncated,
				},
				meta: { reason, summary_chars: summary?.length ?? 0 },
			});
		}

		this.maybeWriteSessionMemory(snap.taskState, window, meta);
		this.trackFileAccess(msg);
		return { summaryTriggered };
	}

	/**
	 * 单独上报用量（turn_end 后调用）。
	 * v1 只在 append 时传 usage，导致「没有工具调用的轮次 token 不上报」——
	 * token 触发实际长期失效（诚实边界里记过）。这里拆成独立入口修正。
	 */
	noteUsage(inputTokens: number): { summaryTriggered: boolean } {
		if (inputTokens <= 0) return { summaryTriggered: false };
		this.inputTokens += inputTokens;
		const snap = this.snapshot();
		snap.taskState.budget.tokens_used = this.inputTokens;
		this.persist(snap.taskState, snap.recentWindow, snap.earlySummary, snap.compactMeta);

		const threshold = this.deps.budgetTokens * (this.deps.summaryTokenRatio ?? SESSION_DEFAULTS.summaryTokenRatio);
		if (this.inputTokens < threshold) return { summaryTriggered: false };
		// token 触发的实际摘要动作在下一次 append 时执行（保持「同步应用」在消息边界上）
		return { summaryTriggered: true };
	}

	/**
	 * 只写账本、不进滚动窗口（user/assistant 对话用）。
	 *
	 * 为什么分开：窗口的语义是「模型下一步要看的工具证据窗口」，
	 * 对话文本归 task_state.objective / 摘要 / 账本管；混进窗口会让
	 * 「K 步」计数失真，也会挤占 70K 预算。
	 */
	recordOnly(msg: SessionMessage): void {
		this.storage()?.append(this.taskId, {
			ts: msg.timestamp,
			kind: msg.role === "toolResult" ? "tool_result" : msg.role,
			tool_name: msg.toolName,
			payload: msg.content,
			tokens: estimateTokens(msg.content),
		});
	}

	/** 取最近 N 条工具结果（中断恢复用：重放最近 3 条，只注入不重新执行） */
	recentToolResults(n: number): SessionMessage[] {
		return this.snapshot()
			.recentWindow.filter((m) => m.role === "toolResult")
			.slice(-n);
	}

	/** 按 ref 回灌原文（渐进式披露：模型/恢复链路需要时取回） */
	rehydrate(ref: string): string {
		const storage = this.storage();
		if (!storage) throw new Error("VULCAN_ARTIFACT_003: 未配置 SessionStorage，无法回灌");
		return storage.rehydrate(ref);
	}

	/** 文件访问台账（对应 CC readFileState） */
	getFileState(): FileAccessEntry[] {
		const row = this.row();
		return parseJson(row?.file_state ?? null, [] as FileAccessEntry[]);
	}

	/** 手工记录一次文件访问（read_file / write_file 自动解析，也可显式调） */
	recordFileAccess(path: string, mode: "read" | "write", tokens: number): void {
		const id = this.ensureSession();
		const list = this.getFileState().filter((e) => e.path !== path);
		list.push({ path, last_access: Date.now(), tokens, mode });
		// 只留最近 50 条，防止台账无限增长
		const trimmed = list.sort((a, b) => a.last_access - b.last_access).slice(-50);
		this.db.prepare("UPDATE sessions SET file_state = ? WHERE id = ?").run(JSON.stringify(trimmed), id);
	}

	/** 从工具结果里自动解析文件路径（read_file / write_file 的返回结构含 path） */
	private trackFileAccess(msg: SessionMessage): void {
		if (msg.role !== "toolResult" || !msg.toolName) return;
		if (!["read_file", "write_file", "apply_patch"].includes(msg.toolName)) return;
		if (msg.ref) return; // 已外置，content 是指针，不再解析
		try {
			const o = JSON.parse(msg.content) as { path?: string; bytes?: number };
			if (o.path) {
				this.recordFileAccess(o.path, msg.toolName === "read_file" ? "read" : "write", estimateTokens(msg.content));
			}
		} catch {
			// 非 JSON 内容，忽略
		}
	}

	/** 读 Session Memory（磁盘文件优先，回落 DB 列） */
	readSessionMemory(): string | null {
		const storage = this.storage();
		const fromDisk = storage?.readSessionMemory(this.taskId) ?? null;
		if (fromDisk) return fromDisk;
		return this.row()?.session_memory ?? null;
	}

	private maybeWriteSessionMemory(state: TaskState, window: SessionMessage[], meta: CompactMeta): void {
		const start = this.deps.sessionMemoryStartTokens ?? SESSION_DEFAULTS.sessionMemoryStartTokens;
		const every = this.deps.sessionMemoryEveryTokens ?? SESSION_DEFAULTS.sessionMemoryEveryTokens;
		if (this.inputTokens < start) return;
		if (this.inputTokens - this.lastMemoryAt < every) return;
		this.lastMemoryAt = this.inputTokens;
		const md = renderSessionMemory(state, window, meta);
		this.writeMemory(md);
	}

	private writeMemory(md: string): void {
		const id = this.ensureSession();
		this.db.prepare("UPDATE sessions SET session_memory = ? WHERE id = ?").run(md, id);
		this.storage()?.writeSessionMemory(this.taskId, md);
	}

	private persist(state: TaskState, window: SessionMessage[], summary: string | null, meta: CompactMeta): void {
		const id = this.ensureSession();
		this.db
			.prepare(
				"UPDATE sessions SET task_state = ?, recent_window = ?, early_summary = ?, compact_meta = ? WHERE id = ?",
			)
			.run(JSON.stringify(state), JSON.stringify(window), summary, JSON.stringify(meta), id);
	}

	/**
	 * 任务结束归档：短期记忆冻结为过程记录，不自动回流后续任务上下文。
	 * 归档时落一份最终 Session Memory + 账本 archive 记录（可审计、可回放）。
	 */
	archive(): void {
		const id = this.ensureSession();
		const snap = this.snapshot();
		const state: TaskState = { ...snap.taskState, progress: { ...snap.taskState.progress, stage: "archived" } };
		this.db
			.prepare("UPDATE sessions SET task_state = ?, recent_window = ? WHERE id = ?")
			.run(JSON.stringify(state), "[]", id);
		this.writeMemory(renderSessionMemory(state, snap.recentWindow, snap.compactMeta));
		this.storage()?.append(this.taskId, {
			ts: Date.now(),
			kind: "archive",
			payload: { steps: state.progress.steps_done.length, tokens: this.inputTokens },
		});
	}
}

/** 默认摘要器（确定性零 LLM），供无 summarize 注入的调用方直接使用 */
export { defaultSummarize };
