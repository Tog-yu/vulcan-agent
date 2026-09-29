/**
 * Cordis 插件化执行层（技术方案 · 四，DEV_SPEC §6/§14 P3-1）。
 *
 * 职责边界：
 *   - 插件契约（VulcanPlugin / ToolPlugin / RetrievalPlugin）与注册表
 *   - setup/dispose 生命周期：setup 抛错 → 启动 fail-fast（回滚已 setup 插件后上抛）
 *   - 依赖注入装配：业务依赖统一接口，不绑定具体实现；按项目可替换
 *   - Cordis 本身不做模型推理；主模型不直接操作工作区，工具执行一律经工具插件
 *
 * 依赖方向（§5）：harness → cordis → config/存储层；支撑模块禁止互相 import。
 */

// ---------- 插件上下文（依赖注入） ----------

/** 插件运行期可用的注入能力（config 按项目选择并注入） */
export interface PluginContext {
	/** 任务级结构化日志 */
	log: (msg: string, extra?: Record<string, unknown>) => void;
	/** 项目/工作区根目录 */
	workspaceRoot: string;
	/** 项目权限范围：允许访问的仓库清单 */
	allowedRepos: string[];
}

// ---------- 插件契约 ----------

/** 所有 Vulcan 插件的公共契约 */
export interface VulcanPlugin {
	/** 插件名（注册表唯一键） */
	readonly name: string;
	/** 装配：初始化资源、注册工具/检索能力。抛错 → 启动 fail-fast */
	setup(ctx: PluginContext): Promise<void> | void;
	/** 卸载：释放资源。进程退出/测试收尾时恰好调用一次 */
	dispose(): Promise<void> | void;
}

/** 工具插件：主模型可调用的一个具名工具（读/改/测/PR 等） */
export interface ToolPlugin extends VulcanPlugin {
	kind: "tool";
	/** 工具名（白名单键） */
	tool: string;
	/** 工具描述（注入主模型提示词） */
	description: string;
	/** 工具入参 JSON Schema（注入主模型提示词） */
	parameters: Record<string, unknown>;
	/**
	 * 执行工具调用。
	 * @param input 主模型给的结构化入参
	 * @param scope 本次调用的工作区约束（allowedRepos / forbidden）
	 */
	execute(input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult>;
}

/** 工具调用的工作区约束 */
export interface ToolScope {
	/** 当前任务允许的仓库（allowed repos） */
	allowedRepos: string[];
	/** 明确禁止触碰的文件/路径（forbidden） */
	forbiddenPaths: string[];
}

export interface ToolResult {
	ok: boolean;
	/** 结构化输出（回填模型） */
	data?: Record<string, unknown>;
	/** 失败原因（ok=false 时必填） */
	error?: string;
}

/**
 * 检索插件：代码/知识检索能力的统一入口
 * （普通项目形态与 GVFS 大仓形态都实现此契约）。
 */
export interface RetrievalPlugin extends VulcanPlugin {
	kind: "retrieval";
	/**
	 * 检索。《技术方案》4.2 四项接口要求：
	 * 1. 权限在召回前过滤（scope 外内容不进召回）
	 * 2. 结果携带版本坐标（repo/branch/file_path/commit/content_hash）
	 * 3. 哈希对齐（与索引声明一致）
	 * 4. 版本核验（下载后核验，不一致显式告警，禁止静默使用）
	 */
	retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}

export interface RetrievalQuery {
	text: string;
	/** 权限范围：检索结果必须落在此范围内（召回前过滤） */
	allowedRepos: string[];
	/** 目标分支（缺省由插件决定默认分支） */
	branch?: string;
	/** 返回条数上限 */
	topK?: number;
}

/** 带版本坐标的检索结果 */
export interface RetrievalResult {
	repo: string;
	branch: string;
	filePath: string;
	commit: string;
	contentHash: string;
	/** 命中的代码片段 */
	snippet: string;
	/** 相关性分数（插件自定义尺度） */
	score: number;
}

// ---------- 注册表与装配 ----------

type Plugin = VulcanPlugin | ToolPlugin | RetrievalPlugin;

function isToolPlugin(p: Plugin): p is ToolPlugin {
	return (p as ToolPlugin).kind === "tool";
}
function isRetrievalPlugin(p: Plugin): p is RetrievalPlugin {
	return (p as RetrievalPlugin).kind === "retrieval";
}

export interface Registry {
	/** 装配全部插件（按注册顺序 setup）。任一抛错 → 回滚已 setup 插件后 rethrow（fail-fast） */
	setupAll(): Promise<void>;
	/** 逆序 dispose 全部插件（进程退出/测试收尾） */
	disposeAll(): Promise<void>;
	getTool(name: string): ToolPlugin | undefined;
	getRetrieval(): RetrievalPlugin | undefined;
	listTools(): ToolPlugin[];
	/** 是否已完成 setupAll */
	readonly ready: boolean;
}

export function createRegistry(plugins: Plugin[], ctx: PluginContext): Registry {
	if (plugins.length === 0) {
		throw new Error("VULCAN_CORDIS_001: 至少注册一个插件（Cordis 不可空装配）");
	}
	// 名字唯一性：注册期即拒绝（fail-fast）
	const names = new Set<string>();
	for (const p of plugins) {
		if (names.has(p.name)) {
			throw new Error(`VULCAN_CORDIS_002: 插件名重复: ${p.name}`);
		}
		names.add(p.name);
	}
	// 检索插件至多一个（执行层当前只允许一条检索链路）
	const retrievals = plugins.filter(isRetrievalPlugin);
	if (retrievals.length > 1) {
		throw new Error(`VULCAN_CORDIS_003: 检索插件至多一个，收到 ${retrievals.length} 个`);
	}

	let setupDone = false;

	const assertReady = (code: string): void => {
		if (!setupDone) throw new Error(`${code}: 未装配完成，禁止取用执行层能力`);
	};

	return {
		get ready() {
			return setupDone;
		},
		async setupAll(): Promise<void> {
			const done: Plugin[] = [];
			for (const p of plugins) {
				try {
					await p.setup(ctx);
					done.push(p);
				} catch (err) {
					// fail-fast：逆序回滚已 setup 的插件后上抛，拒绝带病启动
					for (const d of [...done].reverse()) {
						await d.dispose();
					}
					throw new Error(`VULCAN_CORDIS_004: 插件 ${p.name} setup 失败: ${(err as Error).message}`);
				}
			}
			setupDone = true;
		},
		async disposeAll(): Promise<void> {
			for (const p of [...plugins].reverse()) {
				await p.dispose();
			}
			setupDone = false;
		},
		getTool(name: string): ToolPlugin | undefined {
			assertReady("VULCAN_CORDIS_005");
			return plugins.find((p): p is ToolPlugin => isToolPlugin(p) && p.tool === name);
		},
		getRetrieval(): RetrievalPlugin | undefined {
			assertReady("VULCAN_CORDIS_006");
			return retrievals[0];
		},
		listTools(): ToolPlugin[] {
			assertReady("VULCAN_CORDIS_007");
			return plugins.filter(isToolPlugin);
		},
	};
}
