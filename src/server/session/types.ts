/**
 * 会话记忆类型与默认参数（v2，对照 Claude Code 记忆体系）。
 *
 * 设计来源（笔记 8.3）：
 *   - 左半边 Memory：指令文件 / 对话上下文 / Session Memory / 持久记忆
 *   - 右半边 Transcript：JSONL 会话账本，负责恢复、回放、审计、续接
 *   - 压缩四层：Snip → MicroCompact → Collapse → AutoCompact（本实现取 1/2/4 的可用部分）
 *
 * 与 v1 的兼容约束：TaskState / SessionMessage 字段只增不改，
 * snapshot() / append() / recentToolResults() / archive() 签名不变。
 */

// ---------- 三层短期记忆 ----------

/** 结构化任务状态（恒定 ~2K tokens，权威层） */
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
	/** 正文（user/assistant）或 JSON 序列化结果（toolResult）；外置后为指针 JSON */
	content: string;
	/** toolResult 关联的工具名 */
	toolName?: string;
	timestamp: number;
	/** 外置指针：content 已替换为 `{"ref","bytes","sha256","preview"}` 时记录 ref */
	ref?: string;
	/** 原始字节数（外置/裁剪前的体积，审计与容量核算用） */
	bytes?: number;
	/** L1 Snip 已清除（content 只剩标记文本） */
	cleared?: boolean;
	/** 步号（append 时递增，摘要与定位用） */
	step?: number;
}

/** 压缩元数据（落 sessions.compact_meta，恢复与观测用） */
export interface CompactMeta {
	/** 最近一次压缩发生的步号 */
	last_step: number;
	/** 最近一次触发摘要的原因 */
	last_reason: "step" | "token" | "window" | "archive" | null;
	/** 各层累计动作次数 */
	snip_count: number;
	externalize_count: number;
	summary_count: number;
	/** 硬挤出丢掉的条数（L4 FIFO 兜底） */
	evicted_count: number;
	/** 连续压缩失败次数（≥3 熔断） */
	consecutive_failures: number;
	fused: boolean;
}

/** 文件访问台账（对应 CC 的 readFileState，压缩/恢复后复读最新内容） */
export interface FileAccessEntry {
	path: string;
	/** 最近访问时间戳 */
	last_access: number;
	/** 最近一次读取的 token 估算 */
	tokens: number;
	/** 读/写 */
	mode: "read" | "write";
}

// ---------- Transcript 会话账本 ----------

export type TranscriptKind =
	| "user"
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "compact_boundary"
	| "state_change"
	| "recovery"
	| "archive";

/** JSONL 一行 = 一条结构化记录（append-only，不修改历史行） */
export interface TranscriptRecord {
	/** 账本版本，便于后续迁移 */
	v: 1;
	/** 任务内单调递增序号，从 1 开始 */
	seq: number;
	/** 全局唯一 id：`${taskId}:${seq}` */
	id: string;
	/** 父记录 id（树形分支回放用；线性会话即上一条） */
	parent_id: string | null;
	ts: number;
	kind: TranscriptKind;
	tool_name?: string;
	/** 记录正文（原样保留，不压缩） */
	payload: unknown;
	tokens?: number;
	/** 外置指针（大结果原文在 artifacts 目录） */
	ref?: string;
	/** 压缩边界等附加信息 */
	meta?: Record<string, unknown>;
}

/** 外置指针：窗口里替代原文的那一小段 */
export interface ArtifactPointer {
	ref: string;
	bytes: number;
	sha256: string;
	preview: string;
}

// ---------- 存储抽象 ----------

export interface SessionStorage {
	append(
		taskId: string,
		rec: Omit<TranscriptRecord, "v" | "seq" | "id" | "parent_id"> & { parent_id?: string | null },
	): TranscriptRecord;
	read(taskId: string, opts?: { fromSeq?: number; tail?: number }): TranscriptRecord[];
	externalize(taskId: string, content: string): ArtifactPointer;
	rehydrate(ref: string): string;
	writeSessionMemory(taskId: string, markdown: string): void;
	readSessionMemory(taskId: string): string | null;
}

// ---------- 默认参数（与笔记 §2.3 / §3.3 对齐） ----------

export const SESSION_DEFAULTS = {
	/** Token 预算（60% 触发摘要的分母） */
	budgetTokens: 200_000,
	/** 摘要触发步数阈值 */
	summaryStepInterval: 15,
	/** 预算触发占比 */
	summaryTokenRatio: 0.6,
	/** 滚动窗口 token 上限（≈280KB 字符） */
	windowTokenLimit: 70_000,
	/** 摘要触发后保留的原文条数 */
	keepRecent: 10,
	/** L1 Snip 保留的最近工具结果条数（更早的才允许清） */
	snipKeepRecentToolResults: 6,
	/** L2 单条外置阈值（tokens），≈32KB 字符 */
	externalizeThresholdTokens: 8_000,
	/** 指针预览字符数 */
	previewChars: 2_000,
	/** 连续压缩失败熔断阈值 */
	maxConsecutiveCompactFailures: 3,
	/** Session Memory 启动阈值与更新间隔（tokens） */
	sessionMemoryStartTokens: 10_000,
	sessionMemoryEveryTokens: 5_000,
	/** 恢复时最多复读的文件数、单文件与总预算（tokens） */
	restoreFilesMax: 5,
	restoreFileTokenCap: 5_000,
	restoreTotalTokenCap: 50_000,
	/** 恢复时重放的最近工具结果条数 */
	replayToolResults: 3,
} as const;

/** L1 可清除名单（只读工具，结果可随时重取）——CC 的「可清除白名单」 */
export const CLEARABLE_TOOLS = new Set(["read_file", "list_dir", "search_code", "grep", "glob", "web_fetch"]);

/**
 * 保护名单（语义与 CC 相反：这些结果禁止 Snip）。
 * write_file 产出 patchRef 是审批证据，run_tests 是验证证据，丢了就无法交付。
 */
export const PROTECTED_TOOLS = new Set(["write_file", "run_tests", "apply_patch"]);

/** 初始 task_state 骨架 */
export function initialTaskState(taskId: string): TaskState {
	return {
		task_id: taskId,
		objective: {
			issue: "",
			acceptance_criteria: [],
			constraints: { allow_api_change: false, allowed_repos: [], forbidden: [] },
		},
		progress: { stage: "started", steps_done: [], last_action: "", waiting_on: null },
		context: { base_commit: null, branch: null, patch_ref: [], open_questions: [] },
		assumptions: [],
		todos: [],
		budget: { tokens_used: 0, cost_usd: 0, deadline: null },
	};
}

/** 初始压缩元数据 */
export function initialCompactMeta(): CompactMeta {
	return {
		last_step: 0,
		last_reason: null,
		snip_count: 0,
		externalize_count: 0,
		summary_count: 0,
		evicted_count: 0,
		consecutive_failures: 0,
		fused: false,
	};
}

/** 粗估 token 数（~4 字符/token，够触发判定用，不追求精确分词） */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
