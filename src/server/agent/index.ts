/**
 * Pi AgentLoop 接入（DEV_SPEC §14 P3-2，技术方案 · 四）。
 *
 * 职责：ReAct 循环组织（复用 pi-agent-core 的 runAgentLoop）、工具白名单、
 * allowed repos / forbidden paths 约束。主模型不直接操作工作区——一切工具执行
 * 经 cordis 工具插件；白名单外工具调用在执行前被 beforeToolCall 拦截并记审计。
 *
 * 依赖方向（§5）：harness → agent → cordis；agent 不得绕过 cordis 直接访问存储层。
 */

// ⚠️ pi-agent-core 只能 import type + 动态 import()：其传递依赖 typebox 的递归
// barrel 模块图在 --experimental-strip-types ESM loader 下静态求值会无限挂起
// （entry.ts 启动路径必须完全避开）。runAgentLoop 在 run() 内动态获取。
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Model, Usage } from "@earendil-works/pi-ai";
import type { ToolScope, ToolPlugin } from "../cordis/index.ts";

// ---------- 配置 ----------

export interface AgentBudget {
	/** 最大步数（turn 数），超限强停 */
	maxSteps: number;
	/** 最大总 Token（input+output 合计），超限强停 */
	maxTokens: number;
	/** 最大成本（美元），超限强停 */
	maxCost: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
	maxSteps: 25,
	maxTokens: 200_000,
	maxCost: 2.0,
};

export interface AgentRunDeps {
	/** 模型描述符（StreamFn 的路由键；生产=pi-ai models 目录中的模型） */
	model: Model<any>;
	/**
	 * 模型流函数。生产环境 = models.streamSimple；
	 * 测试注入确定性 mock（Vulcan 不依赖真实模型也能端到端测试）。
	 */
	streamFn: (model: Model<any>, context: unknown, options?: unknown) => AssistantMessageEventStream;
	/** 审计出口：工具拦截/预算超限等安全事件落这里（由调用方接 audit_logs） */
	audit: (event: { kind: "tool_blocked" | "budget_exceeded"; detail: Record<string, unknown> }) => void;
}

export interface AgentRunInput {
	prompt: string;
	systemPrompt: string;
	/** 全量可用工具（来自 cordis registry.listTools()） */
	tools: ToolPlugin[];
	/** 工具白名单：只有名单内的工具可执行；名单外调用被拦截 + 记审计 */
	allowedTools?: string[];
	/** 本次任务的工作区约束 */
	scope: ToolScope;
	budget?: Partial<AgentBudget>;
	signal?: AbortSignal;
	/** 事件观察出口（测试断言 / 未来接 Langfuse trace） */
	onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunOutput {
	/** 最终消息序列（ReAct 全程 transcript） */
	messages: AgentMessage[];
	/** 累计用量（Token/成本） */
	usage: { inputTokens: number; outputTokens: number; cost: number; steps: number };
	/** 结束原因：模型自然停止 / 预算强停 / 外部 abort */
	endReason: "completed" | "budget_exceeded" | "aborted";
}

// ---------- cordis ToolPlugin → pi AgentTool 适配 ----------

/**
 * 把 cordis 工具插件适配成 pi AgentTool。
 * 工具执行仍然走 cordis 契约（execute(input, scope)），主模型只能拿到
 * 结构化入参，没有直接工作区访问路径——文件/命令触达都封装在插件实现里。
 */
function toAgentTool(plugin: ToolPlugin, scope: ToolScope): AgentTool<any> {
	return {
		label: plugin.name,
		name: plugin.tool,
		description: plugin.description,
		parameters: plugin.parameters as any,
		execute: async (_toolCallId: string, params: Record<string, unknown>) => {
			const result = await plugin.execute(params, scope);
			if (!result.ok) {
				// pi 约定：工具失败抛错，循环转错误 tool result
				throw new Error(result.error ?? "tool failed");
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result.data ?? {}) }],
				details: result.data ?? {},
			};
		},
	};
}

// ---------- 主循环 ----------

export class VulcanAgentLoop {
	private readonly deps: AgentRunDeps;

	constructor(deps: AgentRunDeps) {
		this.deps = deps;
	}

	async run(input: AgentRunInput): Promise<AgentRunOutput> {
		const budget: AgentBudget = { ...DEFAULT_BUDGET, ...input.budget };
		const scope = input.scope;
		// 白名单缺省 = 全量可用工具；名单外工具仍注册进 context（pi 循环对未注册工具
		// 直接报 "not found"，不经过 beforeToolCall），靠 beforeToolCall 统一拦截。
		const whitelist = new Set(input.allowedTools ?? input.tools.map((t) => t.tool));
		const audit = this.deps.audit;

		// 用量累计（含预算强停判定）
		const usage = { inputTokens: 0, outputTokens: 0, cost: 0, steps: 0 };
		let endReason: AgentRunOutput["endReason"] = "completed";

		const agentTools = input.tools.map((t) => toAgentTool(t, scope));

		// 组装初始上下文：system 消息 + 用户 prompt
		const messages: AgentMessage[] = [
			{ role: "system", content: input.systemPrompt } as AgentMessage,
			{ role: "user", content: input.prompt, timestamp: Date.now() } as AgentMessage,
		];

		const context = { messages, tools: agentTools };

		// 预算观察：超限 → abortController.abort() 强停（P3-3）
		const abort = new AbortController();
		if (input.signal) {
			input.signal.addEventListener("abort", () => abort.abort(input.signal?.reason), { once: true });
		}

		const checkBudget = (assistant?: AssistantMessage): void => {
			usage.steps += 1;
			if (assistant) {
				usage.inputTokens += assistant.usage?.input ?? 0;
				usage.outputTokens += assistant.usage?.output ?? 0;
				usage.cost += assistant.usage?.cost?.total ?? 0;
			}
			if (usage.steps > budget.maxSteps) {
				audit({ kind: "budget_exceeded", detail: { dimension: "steps", limit: budget.maxSteps, actual: usage.steps } });
				endReason = "budget_exceeded";
				abort.abort(new Error("budget exceeded: steps"));
			} else if (usage.inputTokens + usage.outputTokens > budget.maxTokens) {
				audit({ kind: "budget_exceeded", detail: { dimension: "tokens", limit: budget.maxTokens, actual: usage.inputTokens + usage.outputTokens } });
				endReason = "budget_exceeded";
				abort.abort(new Error("budget exceeded: tokens"));
			} else if (usage.cost > budget.maxCost) {
				audit({ kind: "budget_exceeded", detail: { dimension: "cost", limit: budget.maxCost, actual: usage.cost } });
				endReason = "budget_exceeded";
				abort.abort(new Error("budget exceeded: cost"));
			}
		};

		const emit = (event: AgentEvent): void => {
			// 预算累计挂在 turn_end（每轮一次）
			if (event.type === "turn_end") {
				checkBudget(event.message as AssistantMessage);
			}
			input.onEvent?.(event);
		};

		let finalMessages: AgentMessage[];
		try {
			// 运行期才加载 pi-agent-core（静态导入会在模块求值期触发 typebox 挂死）
			const { runAgentLoop } = await import("@earendil-works/pi-agent-core");
			finalMessages = await runAgentLoop(
				messages,
				context,
				{
					model: this.deps.model,
					convertToLlm: (msgs) => msgs as never[],
					// —— 工具白名单：白名单外调用在执行前拦截 + 审计（P3-2 验收）——
					beforeToolCall: async (ctx: { toolCall: { name: string } }) => {
						const toolName = ctx.toolCall.name;
						if (!whitelist.has(toolName)) {
							audit({ kind: "tool_blocked", detail: { tool: toolName, reason: "not in whitelist", whitelist: [...whitelist] } });
							return { block: true, reason: `工具 ${toolName} 不在白名单内，已拒绝` };
						}
						return undefined;
					},
				} as any,
				emit,
				abort.signal,
				this.deps.streamFn as any,
			);
		} catch (err) {
			// abort（预算强停 / 外部取消）会把 AbortError 抛到这里；预算路径已在 checkBudget 落审计
			if (abort.signal.aborted && endReason === "completed") {
				endReason = "aborted";
			}
			if (endReason === "budget_exceeded") {
				// 预算强停不算异常退出：返回已完成的 transcript
				return { messages: context.messages, usage, endReason };
			}
			throw err;
		}

		if (abort.signal.aborted && endReason === "completed") {
			endReason = "aborted";
		}

		return { messages: finalMessages, usage, endReason };
	}
}

/**
 * 预算强停的编排层联动（P3-3 验收：任务被强停转 failed，trace 完整）。
 * AgentLoop 负责 abort + 审计；任务状态转换属于编排层职责（§5 依赖方向），
 * 由调用方在 run() 返回后按 endReason 处理。
 */
export function applyBudgetOutcome(
	endReason: AgentRunOutput["endReason"],
	usage: AgentRunOutput["usage"],
	handlers: {
		/** endReason=completed */
		onCompleted?: () => void;
		/** endReason=budget_exceeded：编排层把任务 running → failed */
		onBudgetExceeded?: (usage: AgentRunOutput["usage"]) => void;
		/** endReason=aborted：外部取消，编排层决定语义（重试/转人工） */
		onAborted?: () => void;
	},
): void {
	switch (endReason) {
		case "completed":
			handlers.onCompleted?.();
			break;
		case "budget_exceeded":
			handlers.onBudgetExceeded?.(usage);
			break;
		case "aborted":
			handlers.onAborted?.();
			break;
	}
}

// re-export 给类型消费者
export type { ToolScope, ToolPlugin };
