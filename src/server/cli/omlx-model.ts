/**
 * oMLX 本地模型接入（pi-ai 自定义 provider 形态）。
 *
 * 背景见 Obsidian《本地 oMLX 模型部署现状》：本机 oMLX 服务
 * `http://127.0.0.1:8000`（OpenAI 兼容 /v1/chat/completions，API Key 1234），
 * 当前模型 `Qwen3.6-35B-A3B-mxfp4`（Qwen 3.6 MoE / mxfp4，多模态）。
 *
 * pi-ai 的 builtinModels 目录没有 oMLX，走 createProvider 自定义注册：
 *   - api: lazyApi(() => import(".../openai-completions.js"))（/chat/completions 协议）
 *   - auth: envApiKeyAuth → 密钥从 OMLX_API_KEY 环境变量读（默认 1234，与 oMLX 笔记一致）
 *   - baseUrl: OMLX_BASE_URL（默认 http://127.0.0.1:8000/v1）
 *
 * 全部从 "@earendil-works/pi-ai" 主入口取（index.js re-export 了 auth/helpers
 * 与 api/lazy；openai-completions 实现模块用相对路径动态 import，与 providers
 * 内部的 lazy 包装方式一致，不触碰 typebox 静态求值问题）。
 *
 * 兼容性说明（omlx/Qwen3.6 实测，2026-10-01）：
 *   - chat/completions 非流式与流式均正常，tool_calls 正常（finish_reason=tool_calls）
 *   - reasoning_content 独立字段（Qwen3.x 思考分离），非 content 前缀，pi 的
 *     openai-completions 适配层按 reasoning_content 解析，无需特殊 compat
 */

import {
	type Api,
	createModels,
	createProvider,
	envApiKeyAuth,
	lazyApi,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";

/** streamFn 形态与 AgentRunDeps.streamFn 一致（复用 AgentLoop 对 streamFn 的宽化声明） */
type OmlxStreamFn = (
	model: Model<Api>,
	context: unknown,
	options?: unknown,
) => import("@earendil-works/pi-ai").AssistantMessageEventStream;

/** 环境变量读 oMLX 连接参数（有默认值，本地开发零配置可跑） */
export function omlxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
	baseUrl: string;
	modelId: string;
} {
	return {
		// 归一化：pi-ai 在 baseUrl 后直拼 /chat/completions，缺 /v1 会 404（2026-10-02 实测教训）
		baseUrl: normalizeOmlxBaseUrl(env.OMLX_BASE_URL ?? "http://127.0.0.1:8000/v1"),
		modelId: env.OMLX_MODEL_ID ?? "Qwen3.6-35B-A3B-mxfp4",
	};
}

/** baseUrl 归一化：裸 host 补 /v1；已带 /v1 或其他路径原样保留 */
export function normalizeOmlxBaseUrl(raw: string): string {
	const trimmed = raw.replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** oMLX 模型描述符（Model<Api> 全字段；cost 全 0 = 本地推理不计费，预算强停只看 token/步数） */
export function omlxModelDescriptor(cfg: ReturnType<typeof omlxConfigFromEnv>): Model<Api> {
	return {
		id: cfg.modelId,
		name: `oMLX ${cfg.modelId}`,
		api: "openai-completions",
		provider: "omlx",
		baseUrl: cfg.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8192,
	};
}

/** 构造 oMLX provider（每次调用新建；由 createModels 注册后经 getModel 取用） */
export function omlxProvider(cfg: ReturnType<typeof omlxConfigFromEnv>) {
	return createProvider({
		id: "omlx",
		name: "oMLX (local)",
		baseUrl: cfg.baseUrl,
		auth: { apiKey: envApiKeyAuth("oMLX API key", ["OMLX_API_KEY"]) },
		models: [omlxModelDescriptor(cfg)],
		// exports map "./api/*" → "./dist/api/*.js"（不带扩展名的 key 才能命中）
		api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
	});
}

/**
 * 装配 oMLX 生产 streamFn + model（签名与 AgentRunDeps 对齐）。
 *
 * 注意：apiKey 从环境变量解析。oMLX 默认 key 是 1234（笔记口径），
 * 启动脚本/测试需 `OMLX_API_KEY=1234`。未设置时 streamSimple 会抛
 * "Provider is not configured: omlx"（fail-fast，符合预期）。
 */
export async function assembleOmlxPipeline(env: NodeJS.ProcessEnv = process.env): Promise<{
	streamFn: OmlxStreamFn;
	model: Model<Api>;
}> {
	const cfg = omlxConfigFromEnv(env);
	const models = createModels() as Models & { setProvider: (p: ReturnType<typeof omlxProvider>) => void };
	models.setProvider(omlxProvider(cfg));
	const model = models.getModel("omlx", cfg.modelId);
	if (!model) {
		throw new Error(`oMLX 模型目录装配失败：omlx/${cfg.modelId} 未注册`);
	}
	const streamFn: OmlxStreamFn = (m, context, options) => models.streamSimple(m, context as never, options as never);
	return { streamFn, model };
}
