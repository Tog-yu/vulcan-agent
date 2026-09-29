/**
 * 全链路 Trace（DEV_SPEC §14 P4-4，技术方案 9.2）。
 *
 * 统一 trace_id 串起整条链路：意图 → Agent → 状态变化 → 检索 → 工具 → 回答
 * → Token → 耗时 → 异常降级。模型调用侧 span 按 OpenTelemetry GenAI 语义约定
 * 携带 gen_ai.* 属性（gen_ai.request.model / gen_ai.usage.*），Langfuse 据此
 * 自动还原 generation，无需额外埋点。
 *
 * Sink 抽象：生产 = LangfuseSink（langfuse SDK）；测试/离线 = 任意 mock sink。
 * 未配置密钥 → NullSink（no-op），trace 永远不阻断主流程。
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface TraceSpan {
	traceId: string;
	name: string;
	startTime: number;
	endTime?: number;
	/** OpenTelemetry 属性（含 gen_ai.*） */
	attributes: Record<string, string | number | boolean>;
	status?: "ok" | "error";
}

export interface TraceSink {
	createTrace(traceId: string, name: string, attributes?: Record<string, string | number | boolean>): void;
	addSpan(span: TraceSpan): void;
	endTrace(traceId: string, attributes?: Record<string, string | number | boolean>): void;
}

/** 未配置 Langfuse 时的 no-op sink——可观测永远不阻断主流程 */
export class NullSink implements TraceSink {
	createTrace(): void {}
	addSpan(): void {}
	endTrace(): void {}
}

export interface LangfuseSinkOptions {
	publicKey?: string;
	secretKey?: string;
	baseUrl?: string;
}

/**
 * Langfuse sink。密钥缺失时退化为 NullSink；
 * SDK 懒加载（动态 import），测试与无网环境不会触碰 langfuse。
 */
export class LangfuseSink implements TraceSink {
	private readonly enabled: boolean;
	// SDK 实例在首次 createTrace 时动态加载（避免模块级 import 的网络/密钥副作用）
	private clientPromise: Promise<unknown> | null = null;

	constructor(private readonly opts: LangfuseSinkOptions, private readonly delegate: TraceSink = new NullSink()) {
		this.enabled = Boolean(opts.publicKey && opts.secretKey);
	}

	createTrace(traceId: string, name: string, attributes?: Record<string, string | number | boolean>): void {
		if (this.enabled) void this.ensureClient();
		this.delegate.createTrace(traceId, name, attributes);
	}

	addSpan(span: TraceSpan): void {
		this.delegate.addSpan(span);
	}

	endTrace(traceId: string, attributes?: Record<string, string | number | boolean>): void {
		this.delegate.endTrace(traceId, attributes);
	}

	private ensureClient(): Promise<unknown> {
		this.clientPromise ??= import("langfuse")
			.then((mod) => new mod.Langfuse({ publicKey: this.opts.publicKey, secretKey: this.opts.secretKey, baseUrl: this.opts.baseUrl }))
			.catch(() => null); // SDK 加载失败 → 保持 no-op，不抛
		return this.clientPromise;
	}
}

// ---------- gen_ai.* 语义约定属性 ----------

export interface UsageShape {
	input: number;
	output: number;
	cost?: { total: number };
}

/** 模型调用 span 的 gen_ai.* 属性（OpenTelemetry GenAI 语义约定） */
export function genAiAttributes(model: string, usage: UsageShape): Record<string, string | number> {
	return {
		"gen_ai.request.model": model,
		"gen_ai.usage.input_tokens": usage.input,
		"gen_ai.usage.output_tokens": usage.output,
		"gen_ai.usage.total_tokens": usage.input + usage.output,
		...(usage.cost ? { "gen_ai.usage.cost": usage.cost.total } : {}),
	};
}

// ---------- AgentEvent → trace 适配 ----------

/**
 * 把 VulcanAgentLoop 的 onEvent 流翻译成 trace span。
 * 返回值直接接到 agent.run({ onEvent })，全程一个 traceId。
 */
export function agentTraceAdapter(traceId: string, sink: TraceSink, model: string): (event: AgentEvent) => void {
	const toolStarts = new Map<string, number>();
	let turnStart = 0;
	sink.createTrace(traceId, "vulcan.task", { "gen_ai.request.model": model });
	return (event: AgentEvent): void => {
		switch (event.type) {
			case "turn_start":
				turnStart = Date.now();
				break;
			case "turn_end": {
				const msg = event.message as { role: string; usage?: UsageShape; stopReason?: string };
				const attrs: Record<string, string | number | boolean> = {
					...genAiAttributes(model, msg.usage ?? { input: 0, output: 0 }),
					"vulcan.turn.stop_reason": msg.stopReason ?? "unknown",
				};
				if (turnStart) attrs["vulcan.turn.duration_ms"] = Date.now() - turnStart;
				sink.addSpan({ traceId, name: "gen_ai.turn", startTime: turnStart || Date.now(), endTime: Date.now(), attributes: attrs });
				break;
			}
			case "tool_execution_start":
				toolStarts.set(event.toolCallId, Date.now());
				break;
			case "tool_execution_end": {
				const startedAt = toolStarts.get(event.toolCallId) ?? Date.now();
				sink.addSpan({
					traceId,
					name: `tool.${event.toolName}`,
					startTime: startedAt,
					endTime: Date.now(),
					attributes: { "vulcan.tool.name": event.toolName, "vulcan.tool.call_id": event.toolCallId },
				});
				toolStarts.delete(event.toolCallId);
				break;
			}
			case "agent_end":
				sink.endTrace(traceId, { "vulcan.trace.turns": event.messages.length });
				break;
		}
	};
}
