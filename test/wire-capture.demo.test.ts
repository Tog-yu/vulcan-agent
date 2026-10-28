/**
 * 抓包样例：Vulcan AgentLoop 一次完整 ReAct 交互到底发了什么、收了什么。
 *
 * 做法：起一个本地假模型服务（OpenAI 兼容 /v1/chat/completions），
 * 把 oMLX provider 的 baseUrl 指过去，用 Vulcan 真实的 VulcanAgentLoop +
 * pi-ai 真实适配层（openai-completions）跑一轮「查天气」。
 * 服务端把每个 request body 原样落盘 → 这就是线上真实 request。
 *
 * 脚本第 1 次请求回 tool_calls，第 2 次请求回最终答案。
 *
 * 跑法：npx vitest run test/wire-capture.demo.test.ts
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { VulcanAgentLoop, type AgentRunDeps } from "../src/server/agent/index.ts";
import { assembleOmlxPipeline } from "../src/server/cli/omlx-model.ts";
import type { ToolPlugin, ToolScope } from "../src/server/cordis/index.ts";

const PORT = 8899;

/** 抓到的请求体：按到达顺序 */
const captured: Array<{ seq: number; path: string; body: any; headers: Record<string, any> }> = [];

function sseChunks(chunks: unknown[]): string {
	return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
	return {
		id: "chatcmpl-wire-demo",
		object: "chat.completion.chunk",
		created: 1761120000,
		model: "demo-weather-model",
		choices: [{ index: 0, delta, finish_reason: finish }],
		...extra,
	};
}

const usage = { prompt_tokens: 812, completion_tokens: 31, total_tokens: 843 };

function startServer(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		const bufs: Buffer[] = [];
		req.on("data", (b) => bufs.push(b));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(bufs).toString("utf8"));
			const seq = captured.length + 1;
			captured.push({ seq, path: req.url ?? "", body, headers: req.headers as any });

			// 判断这是第几轮：messages 里是否已经出现 role:"tool"（工具结果回灌）
			const hasToolResult = (body.messages ?? []).some((m: any) => m.role === "tool");

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			if (!hasToolResult) {
				// 第 1 轮：模型只决定调哪个工具、参数是什么 —— 不知道也不可能有温度
				res.end(
					sseChunks([
						chunk({
							role: "assistant",
							content: null,
							tool_calls: [
								{
									index: 0,
									id: "call_weather_1",
									type: "function",
									function: { name: "get_weather", arguments: "" },
								},
							],
						}),
						chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"成都"}' } }] }),
						chunk({}, "tool_calls"),
						chunk({}, null, { usage }),
					]),
				);
				return;
			}

			// 第 2 轮：拿到工具结果后才可能给出答案
			res.end(
				sseChunks([
					chunk({ role: "assistant", content: "成都今天 " }),
					chunk({ content: "18℃，小雨。" }),
					chunk({}, "stop"),
					chunk({}, null, { usage }),
				]),
			);
		});
	});
	return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

/** 假工具：查天气（真实走 cordis ToolPlugin 契约） */
function weatherTool(executed: Array<Record<string, unknown>>): ToolPlugin {
	return {
		kind: "tool",
		name: "plugin-get-weather",
		tool: "get_weather",
		description: "查询指定城市的当前天气（温度、天气现象）。",
		parameters: {
			type: "object",
			properties: {
				city: { type: "string", description: "城市名，如「成都」" },
			},
			required: ["city"],
		},
		setup() {},
		dispose() {},
		async execute(input: Record<string, unknown>) {
			executed.push(input);
			return { ok: true, data: { city: input.city, temp: 18, condition: "小雨" } };
		},
	};
}

describe("wire capture：一次 ReAct 的完整信息交互", () => {
	it("查天气 → tool_calls → 工具执行 → 结果回灌 → 最终答案", async () => {
		const server = await startServer();
		try {
			process.env.OMLX_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
			process.env.OMLX_API_KEY = "1234";
			process.env.OMLX_MODEL_ID = "demo-weather-model";

			const { streamFn, model } = await assembleOmlxPipeline();
			const executed: Array<Record<string, unknown>> = [];
			const events: string[] = [];
			const deps: AgentRunDeps = {
				model,
				streamFn: streamFn as AgentRunDeps["streamFn"],
				audit: (e) => events.push(`audit:${e.kind}`),
			};
			const scope: ToolScope = { allowedRepos: ["demo"], forbiddenPaths: [] };
			const loop = new VulcanAgentLoop(deps);

			const out = await loop.run({
				prompt: "成都今天天气怎么样？",
				systemPrompt: "你是 Vulcan 助手。需要外部事实时必须调用工具，不要臆测。",
				tools: [weatherTool(executed)],
				allowedTools: ["get_weather"],
				scope,
				onEvent: (e) => events.push(e.type),
			});

			// —— 断言：两轮模型调用、一次工具执行 ——
			expect(captured.length).toBe(2);
			expect(executed).toEqual([{ city: "成都" }]);
			expect(out.usage.steps).toBe(2);
			expect(out.endReason).toBe("completed");

			// —— 落盘抓包结果，供笔记引用 ——
			const fs = await import("node:fs");
			fs.mkdirSync("/tmp/vulcan-wire", { recursive: true });
			fs.writeFileSync("/tmp/vulcan-wire/captured.json", JSON.stringify(captured, null, 2));
			fs.writeFileSync(
				"/tmp/vulcan-wire/transcript.json",
				JSON.stringify({ messages: out.messages, usage: out.usage, events }, null, 2),
			);

			console.log("=== CAPTURED REQUESTS ===");
			for (const c of captured) console.log(`#${c.seq} ${c.path}\n` + JSON.stringify(c.body, null, 2));
			console.log("=== EVENTS ===", events.join(" → "));
			console.log("=== TRANSCRIPT ===", JSON.stringify(out.messages, null, 2));
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 60_000);
});
