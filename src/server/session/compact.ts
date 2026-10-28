/**
 * 四层压缩流水线（对照 Claude Code 的 Snip / MicroCompact / AutoCompact）。
 *
 * 本实现的取舍（对齐笔记「我的 Agent 需要这么复杂吗」）：
 *   L1 Snip          ✅ 同步、零 LLM——清旧只读工具结果，保留消息结构
 *   L2 Protect+外置  ✅ 同步——保护名单反语义 + 单条超阈值落 artifact、窗口换指针
 *   L3 增量摘要      ✅ 步数/预算触发，优先用 Session Memory（零额外 LLM）
 *   L4 硬预算        ✅ 先按大小外置、再 FIFO、最后截断；连续失败 3 次熔断
 *   Collapse 折叠    ❌ 不做——依赖常驻子 agent，收益/复杂度不划算
 *   MicroCompact 时间触发 ❌ 不做——它服务的是 Anthropic 侧 prompt cache 过期
 *
 * 所有函数都是纯函数（除 storage 外置 IO），便于单测。
 */

import { pointerToContent } from "./transcript.ts";
import type { ArtifactPointer, CompactMeta, SessionMessage, SessionStorage, TaskState } from "./types.ts";
import { CLEARABLE_TOOLS, estimateTokens, PROTECTED_TOOLS, SESSION_DEFAULTS } from "./types.ts";

export interface CompactTuning {
	snipKeepRecentToolResults: number;
	externalizeThresholdTokens: number;
	windowTokenLimit: number;
}

/** 从 deps 组装调参（未传的取默认） */
export function tuning(deps: Partial<CompactTuning> = {}): CompactTuning {
	return {
		snipKeepRecentToolResults: deps.snipKeepRecentToolResults ?? SESSION_DEFAULTS.snipKeepRecentToolResults,
		externalizeThresholdTokens: deps.externalizeThresholdTokens ?? SESSION_DEFAULTS.externalizeThresholdTokens,
		windowTokenLimit: deps.windowTokenLimit ?? SESSION_DEFAULTS.windowTokenLimit,
	};
}

/** 窗口总 token */
export function windowTokens(window: SessionMessage[]): number {
	return window.reduce((n, m) => n + estimateTokens(m.content), 0);
}

/** 一条消息是否可被 Snip：只读工具结果、未清、未外置（指针已经是小体积）、非保护名单 */
export function isSnipable(m: SessionMessage): boolean {
	if (m.role !== "toolResult" || m.cleared) return false;
	if (!m.toolName || PROTECTED_TOOLS.has(m.toolName)) return false;
	if (!CLEARABLE_TOOLS.has(m.toolName)) return false;
	if (m.ref) return false;
	return true;
}

/**
 * L1 Snip：保留最近 N 条工具结果原文，更早的可清除结果替换为标记。
 *
 * 关键约束：**只换 content，不删消息** —— tool_use / tool_result 的配对关系
 * 一旦拆开，上游 API 会直接报错。role / toolName / timestamp / step 全部保留。
 */
export function snipOldToolResults(
	window: SessionMessage[],
	t: CompactTuning,
): { window: SessionMessage[]; snipped: number } {
	const snipableIdx: number[] = [];
	window.forEach((m, i) => {
		if (isSnipable(m)) snipableIdx.push(i);
	});
	const keep = Math.max(0, t.snipKeepRecentToolResults);
	const candidates = snipableIdx.slice(0, Math.max(0, snipableIdx.length - keep));
	if (candidates.length === 0) return { window, snipped: 0 };

	let snipped = 0;
	const next = window.slice();
	for (const i of candidates) {
		const m = next[i];
		if (!m) continue;
		next[i] = {
			...m,
			content: `[Old tool result content cleared: ${m.toolName ?? "tool"}, ${m.bytes ?? m.content.length} bytes, step ${m.step ?? "?"}]`,
			cleared: true,
		};
		snipped += 1;
	}
	return { window: next, snipped };
}

/**
 * L2 外置：单条工具结果超阈值 → 原文落 artifact，窗口里只留指针 + 2KB 预览。
 * 这是「不占常驻上下文」的唯一路径（保护名单只解决删不删，不解决占不占）。
 */
export function externalizeLargeToolResults(
	window: SessionMessage[],
	storage: SessionStorage,
	taskId: string,
	t: CompactTuning,
): { window: SessionMessage[]; externalized: number } {
	let count = 0;
	const next = window.map((m) => {
		if (m.role !== "toolResult" || m.ref || m.cleared) return m;
		if (estimateTokens(m.content) <= t.externalizeThresholdTokens) return m;
		const ptr = storage.externalize(taskId, m.content);
		count += 1;
		return {
			...m,
			content: pointerToContent(ptr),
			ref: ptr.ref,
			bytes: ptr.bytes,
		};
	});
	return { window: next, externalized: count };
}

/**
 * L4 硬预算：把窗口压回上限以内。
 *
 * 顺序（与「谁最该被牺牲」的价值判断一致）：
 *   1. 先把最大的、还没外置的工具结果外置（证据留给磁盘，窗口只留指针）
 *   2. 仍超 → 从头部 FIFO 挤（保底，至少留 1 条）
 *   3. 单条独占仍超 → 对最后一条截断（工具结果外置；文本消息截中段）
 */
export function enforceWindowLimit(
	window: SessionMessage[],
	storage: SessionStorage,
	taskId: string,
	t: CompactTuning,
): { window: SessionMessage[]; evicted: number; externalized: number; truncated: boolean } {
	let next = window.slice();
	let externalized = 0;
	let evicted = 0;
	let truncated = false;

	// 1. 最大的先外置（修 v1「按位置挤、最早的大结果最先丢」的坑）
	if (windowTokens(next) > t.windowTokenLimit) {
		const r = externalizeLargest(next, storage, taskId, t);
		next = r.window;
		externalized += r.externalized;
	}

	// 2. FIFO 兜底
	while (next.length > 1 && windowTokens(next) > t.windowTokenLimit) {
		next.shift();
		evicted += 1;
	}

	// 3. 单条独占仍超：不再死守（v1 的 `length > 1` 守卫会永久超限）
	const last = next[0];
	if (next.length === 1 && last && windowTokens(next) > t.windowTokenLimit) {
		if (last.role === "toolResult" && !last.ref) {
			const ptr = storage.externalize(taskId, last.content);
			next = [{ ...last, content: pointerToContent(ptr), ref: ptr.ref, bytes: ptr.bytes }];
			externalized += 1;
		} else if (last.role !== "toolResult") {
			next = [{ ...last, content: truncateMiddle(last.content, t.windowTokenLimit * 4) }];
			truncated = true;
		}
	}

	return { window: next, evicted, externalized, truncated };
}

/** 把 token 数最大的未外置工具结果外置（一次只处理一条，调用方按需循环） */
function externalizeLargest(
	window: SessionMessage[],
	storage: SessionStorage,
	taskId: string,
	_t: CompactTuning,
): { window: SessionMessage[]; externalized: number } {
	let bestIdx = -1;
	let bestTokens = 0;
	window.forEach((m, i) => {
		if (m.role !== "toolResult" || m.ref || m.cleared) return;
		const tk = estimateTokens(m.content);
		if (tk > bestTokens) {
			bestTokens = tk;
			bestIdx = i;
		}
	});
	if (bestIdx < 0) return { window, externalized: 0 };
	const m = window[bestIdx] as SessionMessage;
	const ptr: ArtifactPointer = storage.externalize(taskId, m.content);
	const next = window.slice();
	next[bestIdx] = { ...m, content: pointerToContent(ptr), ref: ptr.ref, bytes: ptr.bytes };
	return { window: next, externalized: 1 };
}

/** 中段截断：保留头 70% + 尾 20%，中间打标记（幂等：已含标记不再处理） */
export function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.7);
	const tail = Math.floor(maxChars * 0.2);
	const dropped = text.length - head - tail;
	return `${text.slice(0, head)}\n…[truncated ${dropped} chars]…\n${text.slice(text.length - tail)}`;
}

/** 压缩结果汇总（写 compact_boundary 与 compact_meta 用） */
export interface CompactPassResult {
	window: SessionMessage[];
	summary: string | null;
	summaryTriggered: boolean;
	snipCount: number;
	externalizeCount: number;
	evictedCount: number;
	truncated: boolean;
	reason: CompactMeta["last_reason"];
}

// ---------- Session Memory（结构化笔记，L3 的零 LLM 摘要源） ----------

/**
 * 渲染 Session Memory：CC 的 9 段结构化模板。
 * 全部内容由 task_state + 窗口确定性推导（不调 LLM），因此可以每 5K tokens 免费刷新。
 */
export function renderSessionMemory(taskState: TaskState, window: SessionMessage[], meta: CompactMeta): string {
	const tools = [
		...new Set(window.filter((m) => m.role === "toolResult" && m.toolName).map((m) => m.toolName as string)),
	];
	const files = [
		...new Set(
			window
				.filter((m) => m.role === "toolResult" && m.toolName && ["read_file", "write_file"].includes(m.toolName))
				.map((m) => {
					try {
						const o = JSON.parse(m.ref ? "{}" : m.content) as { path?: string };
						return o.path ?? "";
					} catch {
						return "";
					}
				})
				.filter(Boolean),
		),
	];
	const stage = taskState.progress.stage;
	return [
		`# Session Memory: ${taskState.task_id}`,
		"",
		`> 自动生成于步 ${taskState.progress.steps_done.length}，压缩元数据：摘要 ${meta.summary_count} 次 / Snip ${meta.snip_count} 次 / 外置 ${meta.externalize_count} 次`,
		"",
		"## 核心请求",
		taskState.objective.issue || "（未记录）",
		"",
		"## 关键概念 / 约束",
		taskState.objective.constraints.forbidden.length > 0
			? `禁区：${taskState.objective.constraints.forbidden.join("、")}`
			: "（无显式禁区）",
		`允许改 API：${taskState.objective.constraints.allow_api_change ? "是" : "否"}；涉及仓：${taskState.objective.constraints.allowed_repos.join("、") || "（未限定）"}`,
		"",
		"## 涉及文件",
		files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "（暂无文件访问记录）",
		"",
		"## 错误与修复",
		taskState.assumptions.filter((a) => a.status === "refuted").length > 0
			? taskState.assumptions
					.filter((a) => a.status === "refuted")
					.map((a) => `- ~~${a.text}~~（已证伪${a.evidence ? `：${a.evidence}` : ""}）`)
					.join("\n")
			: "（暂无已证伪假设）",
		"",
		"## 问题解决过程",
		`阶段：${stage}；最近动作：${taskState.progress.last_action || "（无）"}；使用工具：${tools.join("、") || "（无）"}`,
		"",
		"## 待办",
		taskState.todos.length > 0 ? taskState.todos.map((t) => `- [ ] ${t}`).join("\n") : "（无）",
		"",
		"## 当前工作",
		`等待项：${taskState.progress.waiting_on ?? "无"}；基线：${taskState.context.base_commit ?? "未定基"}`,
		"",
		"## 下一步",
		taskState.todos[0] ? taskState.todos[0] : "（由 Agent 决定）",
		"",
	].join("\n");
}

/**
 * 默认摘要器（确定性、零 LLM）：把被挤出窗口的消息渲染成结构化摘要。
 * 生产可注入 LLM 摘要器替换（deps.summarize），签名一致。
 */
export function defaultSummarize(earlySummary: string | null, evicted: SessionMessage[]): string {
	const tools = evicted.filter((m) => m.role === "toolResult").map((m) => m.toolName ?? "tool");
	const refs = evicted.filter((m) => m.ref).length;
	const cleared = evicted.filter((m) => m.cleared).length;
	const head = earlySummary ? `${earlySummary}\n` : "";
	return `${head}## 已移出窗口的 ${evicted.length} 条\n- 工具调用：${tools.join("、") || "（无）"}\n- 其中已外置：${refs} 条；已 Snip：${cleared} 条\n- 结论已合并到本摘要（原文见 Transcript 账本）`;
}
