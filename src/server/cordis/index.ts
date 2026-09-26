/**
 * Cordis 插件化执行层（技术方案 · 四）
 *
 * 职责：插件注册、依赖注入、装配与生命周期管理。
 * 业务依赖统一接口，不直接绑定具体实现，可按项目配置替换执行能力。
 * Cordis 本身不进行模型推理；可替换性来自统一接口和适配器。
 */

// ---------- 插件契约 ----------

export interface PluginContext {
	/** 插件可用的配置（由装配时注入） */
	config: Record<string, unknown>;
	logger: (msg: string) => void;
}

export interface VulcanPlugin {
	/** 插件名，注册表内唯一 */
	name: string;
	/** 插件类别：tool（工具执行）/ retrieval（检索）/ generic（其他） */
	kind: "tool" | "retrieval" | "generic";
	/** 生命周期：装配（依赖注入完成后） */
	setup(ctx: PluginContext): Promise<void>;
	/** 生命周期：卸载（进程退出 / 热替换前） */
	dispose?(): Promise<void>;
}

/** 工具执行插件：在允许范围内实际执行读取、修改和测试，把结果返回 AgentLoop */
export interface ToolPlugin extends VulcanPlugin {
	kind: "tool";
	tools: Array<{
		name: string;
		description: string;
		invoke(args: Record<string, unknown>): Promise<Record<string, unknown>>;
	}>;
}

/** 检索插件：代码搜索与上下文获取；普通项目本地检索，大仓库接企业检索 */
export interface RetrievalPlugin extends VulcanPlugin {
	kind: "retrieval";
	search(
		query: string,
		opts: { repo: string; topK?: number },
	): Promise<Array<{ path: string; score: number; snippet: string }>>;
}

// ---------- 注册表 ----------

export class PluginRegistry {
	readonly #plugins = new Map<string, VulcanPlugin>();

	register(plugin: VulcanPlugin): void {
		if (this.#plugins.has(plugin.name)) {
			throw new Error(`plugin already registered: ${plugin.name}`);
		}
		this.#plugins.set(plugin.name, plugin);
	}

	get<T extends VulcanPlugin>(name: string): T | undefined {
		return this.#plugins.get(name) as T | undefined;
	}

	list(): VulcanPlugin[] {
		return [...this.#plugins.values()];
	}

	/** 装配全部插件（顺序注册、统一 setup） */
	async setupAll(ctx: PluginContext): Promise<void> {
		for (const p of this.#plugins.values()) {
			await p.setup(ctx);
			ctx.logger(`[cordis] plugin ready: ${p.name} (${p.kind})`);
		}
	}

	async disposeAll(): Promise<void> {
		for (const p of [...this.#plugins.values()].reverse()) {
			await p.dispose?.();
		}
	}
}
