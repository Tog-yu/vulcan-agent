/**
 * 真·Cordis 运行时服务层（参考 DeepSeek Harness "一切皆插件" 架构）。
 *
 * 底座 = npm 上的 cordis v4（Koishi 生态的插件元框架，DSH vendored 的同源框架）。
 * 职责划分对齐 DSH：
 *   - 能力做成 Service（挂在 ctx.tools / ctx.retrieval / ctx.agent 上，构造即注册，
 *     随 fiber 卸载自动移除）
 *   - 功能做成 Plugin（{ name, inject, apply(ctx, config) }，靠 inject 声明依赖，
 *     框架负责等依赖就绪）
 *
 * 与旧自研注册表（cordis/index.ts createRegistry）的关系：
 *   - 契约（ToolPlugin / RetrievalPlugin / PluginContext）保持不变、继续复用
 *   - 生命周期从手写 setupAll/disposeAll 迁移到 cordis fiber 托管
 *
 * 依赖方向（DEV_SPEC §5）：agent → cordis → config/存储层。
 */

import { Service } from "cordis";
import type { PluginContext, RetrievalPlugin, ToolPlugin } from "./index.ts";

// ---------- 工具运行时（ctx.tools） ----------

/** 工具插件注册/查询运行时。生命周期由 cordis fiber 托管（fiber 卸载即消失）。 */
export class ToolService extends Service {
	/** 插件名 → 工具插件（键来自 ToolPlugin.name，与旧注册表口径一致） */
	private readonly byName = new Map<string, ToolPlugin>();

	constructor(ctx: PluginAugmentedContext) {
		super(ctx, "tools");
	}

	/** 注册工具插件；重名 fail-fast（对齐旧注册表 VULCAN_CORDIS_002 语义） */
	register(plugin: ToolPlugin): void {
		if (this.byName.has(plugin.name)) {
			throw new Error(`VULCAN_CORDIS_002: 插件名重复: ${plugin.name}`);
		}
		this.byName.set(plugin.name, plugin);
	}

	get(name: string): ToolPlugin | undefined {
		return this.byName.get(name);
	}

	/** 工具名（ToolPlugin.tool）→ 插件；对齐旧 registry.getTool 语义 */
	getByToolName(tool: string): ToolPlugin | undefined {
		for (const p of this.byName.values()) {
			if (p.tool === tool) return p;
		}
		return undefined;
	}

	list(): ToolPlugin[] {
		return [...this.byName.values()];
	}
}

// ---------- 检索运行时（ctx.retrieval） ----------

/** 检索插件运行时：与旧注册表一致，检索链路只允许一条。 */
export class RetrievalService extends Service {
	private plugin: RetrievalPlugin | null = null;

	constructor(ctx: PluginAugmentedContext) {
		super(ctx, "retrieval");
	}

	/** 注册检索插件；重复注册 fail-fast（对齐 VULCAN_CORDIS_003：至多一条检索链路） */
	register(plugin: RetrievalPlugin): void {
		if (this.plugin) {
			throw new Error("VULCAN_CORDIS_003: 检索插件至多一个");
		}
		this.plugin = plugin;
	}

	get(): RetrievalPlugin | null {
		return this.plugin;
	}
}

// ---------- Agent 运行时（ctx.agent） ----------

/** VulcanAgentLoop 的最小运行面（避免 cordis 运行时静态 import pi-agent-core） */
export interface AgentRunner {
	run(input: Parameters<import("../agent/index.ts").VulcanAgentLoop["run"]>[0]): Promise<
		import("../agent/index.ts").AgentRunOutput
	>;
}

/** AgentLoop 运行时：把 Agent 执行能力作为服务暴露给其他插件 */
export class AgentService extends Service {
	private runner: AgentRunner | null = null;

	constructor(ctx: PluginAugmentedContext) {
		super(ctx, "agent");
	}

	/** 绑定执行器（entry.ts 装配时传入；不绑定时 get 抛错，拒绝裸调用） */
	bind(runner: AgentRunner): void {
		this.runner = runner;
	}

	get(): AgentRunner {
		if (!this.runner) throw new Error("VULCAN_CORDIS_008: agent runner 未绑定");
		return this.runner;
	}
}

// ---------- Context 类型增强（cordis 服务挂点） ----------

/**
 * PluginContext 的服务化扩展：cordis context 在此之上额外挂 tools/retrieval/agent。
 * 插件里通过 ctx.tools / ctx.retrieval / ctx.agent 取用。
 */
export interface PluginAugmentedContext extends PluginContext {
	tools: ToolService;
	retrieval: RetrievalService;
	agent: AgentService;
	/** 任务级结构化日志（继承自 PluginContext） */
	log: (msg: string, extra?: Record<string, unknown>) => void;
	/** cordis 原生 logger（命名空间日志） */
	logger: unknown;
}
