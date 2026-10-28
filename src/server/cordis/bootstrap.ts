/**
 * Cordis 装配器（参考 DSH boot 流程）。
 *
 * 装配顺序（依赖自动推导）：
 *   1. new Context()
 *   2. ctx.plugin(ToolService / RetrievalService / AgentService)   —— 能力层
 *   3. ctx.plugin(每个 ToolPlugin / RetrievalPlugin 包装成 cordis 插件) —— 功能层
 *   4. 返回 { ctx, tools, retrieval, agent, dispose }
 *
 * 退出时 ctx.fiber.dispose() 逆序卸载全部插件（cordis 托管，等价旧 disposeAll）。
 * setup 抛错 → fiber 启动失败 → createCordisRuntime 上抛（等价旧 fail-fast + 回滚）。
 */

// 运行时用真 cordis；类型用 src/types/cordis.d.ts 的 ambient 声明
// （npm cordis 的 d.ts 在 moduleResolution=Node16 下解析失败，见该文件头注释）。
import { Context } from "cordis";
import type { PluginContext, RetrievalPlugin, ToolPlugin, VulcanPlugin } from "./index.ts";
import { AgentService, RetrievalService, ToolService } from "./runtime.ts";
import type { PluginAugmentedContext } from "./runtime.ts";

// ---------- 插件包装（VulcanPlugin 契约 → cordis 插件） ----------
function asCordisPlugin(plugin: VulcanPlugin, pluginCtx: PluginContext) {
	// 按契约类型声明注入：读 ctx.tools / ctx.retrieval 必须显式 inject（cordis 强约束）
	const isTool = (plugin as ToolPlugin).kind === "tool";
	const isRetrieval = (plugin as RetrievalPlugin).kind === "retrieval";
	const inject = isTool ? ["tools"] : isRetrieval ? ["retrieval"] : [];
	const cordisPlugin = {
		name: plugin.name,
		inject,
		async apply(ctx: Context) {
			// Vulcan 契约的 setup 接收 PluginContext（log/workspaceRoot/allowedRepos），
			// 而不是 cordis context——两者职责不同，不混用。setup 可返回 promise（异步插件）。
			await plugin.setup(pluginCtx);
			// 按契约类型注册到对应服务（能力发现点：插件 → Service）
			if (isTool) {
				(ctx as unknown as { tools: ToolService }).tools.register(plugin as ToolPlugin);
			} else if (isRetrieval) {
				(ctx as unknown as { retrieval: RetrievalService }).retrieval.register(plugin as RetrievalPlugin);
			}
			// dispose 托管给 cordis fiber：ctx.fiber.dispose() 逆序触发
			ctx.effect(() => () => plugin.dispose());
		},
	};
	return cordisPlugin;
}

/** 装配产物：cordis context + 三个服务门面 + 退出函数 */
export interface CordisRuntime {
	ctx: Context;
	/** 工具运行时（ctx.tools） */
	tools: ToolService;
	/** 检索运行时（ctx.retrieval） */
	retrieval: RetrievalService;
	/** Agent 运行时（ctx.agent） */
	agent: AgentService;
	/** 逆序卸载全部插件（优雅退出用；等价旧 registry.disposeAll） */
	dispose: () => Promise<void>;
}

/**
 * 装配 Cordis 执行层。
 *
 * @param plugins  业务插件清单（ToolPlugin / RetrievalPlugin，实现 VulcanPlugin 契约）
 * @param pluginCtx 注入给插件的运行上下文（log / workspaceRoot / allowedRepos）
 * @returns 装配完成的 CordisRuntime；任一插件 setup 抛错则上抛（fail-fast）
 */
export async function createCordisRuntime(plugins: VulcanPlugin[], pluginCtx: PluginContext): Promise<CordisRuntime> {
	if (plugins.length === 0) {
		throw new Error("VULCAN_CORDIS_001: 至少注册一个插件（Cordis 不可空装配）");
	}

	// 注册期校验（对齐旧注册表语义，fail-fast 提前到装配时）
	const names = new Set<string>();
	for (const p of plugins) {
		if (names.has(p.name)) throw new Error(`VULCAN_CORDIS_002: 插件名重复: ${p.name}`);
		names.add(p.name);
	}
	const retrievals = plugins.filter((p): p is RetrievalPlugin => (p as RetrievalPlugin).kind === "retrieval");
	if (retrievals.length > 1) {
		throw new Error(`VULCAN_CORDIS_003: 检索插件至多一个，收到 ${retrievals.length} 个`);
	}

	const ctx = new Context();

	// 能力层：三个 Service（构造即注册到 ctx，随 fiber 卸载自动移除）
	await ctx.plugin(ToolService as never);
	await ctx.plugin(RetrievalService as never);
	await ctx.plugin(AgentService as never);

	// 功能层：业务插件逐个挂载。任何一个 setup 抛错 → fiber 失败 → 上抛并停在此处；
	// 已挂载插件由调用方 dispose（或进程退出）统一回收。
	const mounted: Array<{ dispose: () => Promise<void> | void }> = [];
	try {
		for (const p of plugins) {
			const plugin = asCordisPlugin(p, pluginCtx);
			await ctx.plugin(plugin as never);
			mounted.push({ dispose: () => p.dispose() });
		}
	} catch (err) {
		// fail-fast：逆序回滚已挂载插件后上抛，拒绝带病启动（对齐旧 setupAll 语义）
		for (const m of [...mounted].reverse()) {
			await m.dispose();
		}
		throw new Error(`VULCAN_CORDIS_004: 插件 setup 失败: ${(err as Error).message}`, { cause: err });
	}

	const tools = (ctx as unknown as { tools: ToolService }).tools;
	const retrieval = (ctx as unknown as { retrieval: RetrievalService }).retrieval;
	const agent = (ctx as unknown as { agent: AgentService }).agent;

	return {
		ctx,
		tools,
		retrieval,
		agent,
		async dispose() {
			await ctx.fiber.dispose();
		},
	};
}

/** PluginAugmentedContext 再导出（插件消费方 import 单点） */
export type { PluginAugmentedContext };
