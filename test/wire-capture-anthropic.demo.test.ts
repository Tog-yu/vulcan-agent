/**
 * 抓包样例 B：同一场景走 Anthropic Messages 协议，对比 request 结构差异。
 *
 * 结论预告：工具在两条协议里都是「顶层字段」，但字段名和消息角色不一样。
 *   OpenAI   → tools[].function{name,description,parameters}；工具结果 role:"tool" + tool_call_id
 *   Anthropic→ tools[]{name,description,input_schema}；工具结果 role:"user" 里的 tool_result block
 *
 * 跑法：npx vitest run test/wire-capture-anthropic.demo.test.ts
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { VulcanAgentLoop, type AgentRunDeps } from "../src/server/agent/index.ts";
import type { ToolPlugin, ToolScope } from "../src/server/cordis/index.ts";

const PORT = 8898;
const captured: Array<{ seq: number; path: string; body: any }> = [];

function ev(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function startServer(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const bufs: Buffer[] = [];
		req.on("data", (b) => bufs.push(b));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(bufs).toString("utf8"));
			const seq = captured.length + 1;
			captured.push({ seq, path: req.url ?? "", body });
			const hasToolResult = (body.messages ?? []).some((m: any) =>
				Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"),
			);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const head = ev("message_start", {
				type: "message_start",
				message: {
					id: `msg_wire_${seq}`,
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 812, output_tokens: 1 },
				},
			});
			if (!hasToolResult) {
				res.end(
					head +
						ev("content_block_start", {
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "toolu_wire_1", name: "get_weather", input: {} },
						}) +
						ev("content_block_delta", {
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: '{"city":"成都"}' },
						}) +
						ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
						ev("message_delta", {
							type: "message_delta",
							delta: { stop_reason: "tool_use", stop_sequence: null },
							usage: { output_tokens: 31 },
						}) +
						ev("message_stop", { type: "message_stop" }),
				);
				return;
			}
			res.end(
				head +
					ev("content_block_start", {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					}) +
					ev("content_block_delta", {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "成都今天 18℃，小雨。" },
					}) +
					ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
					ev("message_delta", {
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 31 },
					}) +
					ev("message_stop", { type: "message_stop" }),
			);
		});
	});
	return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

function weatherTool(executed: Array<Record<string, unknown>>): ToolPlugin {
	return {
		kind: "tool",
		name: "plugin-get-weather",
		tool: "get_weather",
		description: "查询指定城市的当前天气（温度、天气现象）。",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "城市名，如「成都」" } },
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

describe("wire capture B：Anthropic Messages 协议", () => {
	it("同一场景，request 结构与 OpenAI 的差异", async () => {
		const server = await startServer();
		try {
			const { createModels, createProvider, envApiKeyAuth, lazyApi } = await import("@earendil-works/pi-ai");
			const baseUrl = `http://127.0.0.1:${PORT}`;
			const model = {
				id: "demo-anthropic-model",
				name: "demo anthropic",
				api: "anthropic-messages",
				provider: "demo-anthropic",
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
			} as any;
			const provider = createProvider({
				id: "demo-anthropic",
				name: "demo anthropic",
				baseUrl,
				auth: { apiKey: envApiKeyAuth("demo key", ["ANTHROPIC_API_KEY", "DEMO_ANTHROPIC_KEY"]) },
				models: [model],
				api: lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages")),
			});
			process.env.DEMO_ANTHROPIC_KEY = "sk-ant-demo";
			const models = createModels() as any;
			models.setProvider(provider);
			const resolved = models.getModel("demo-anthropic", "demo-anthropic-model") ?? model;

			const executed: Array<Record<string, unknown>> = [];
			const deps: AgentRunDeps = {
				model: resolved,
				streamFn: ((m: any, c: any, o: any) => models.streamSimple(m, c, o)) as AgentRunDeps["streamFn"],
				audit: () => {},
			};
			const scope: ToolScope = { allowedRepos: ["demo"], forbiddenPaths: [] };
			const loop = new VulcanAgentLoop(deps);
			const out = await loop.run({
				prompt: "成都今天天气怎么样？",
				systemPrompt: "你是 Vulcan 助手。需要外部事实时必须调用工具，不要臆测。",
				tools: [weatherTool(executed)],
				allowedTools: ["get_weather"],
				scope,
			});

			expect(captured.length).toBe(2);
			expect(executed).toEqual([{ city: "成都" }]);
			expect(out.endReason).toBe("completed");

			const fs = await import("node:fs");
			fs.mkdirSync("/tmp/vulcan-wire", { recursive: true });
			fs.writeFileSync("/tmp/vulcan-wire/captured-anthropic.json", JSON.stringify(captured, null, 2));
			console.log("=== ANTHROPIC CAPTURED ===");
			for (const c of captured) console.log(`#${c.seq} ${c.path}\n` + JSON.stringify(c.body, null, 2));
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 60_000);
});
