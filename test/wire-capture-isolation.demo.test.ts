/**
 * 隔离实验（生产同构版）：reasoning:true + 真实工具，复现「system/user 重复注入」并验证修复。
 *
 * A = Vulcan 现状：runAgentLoop(messages, { messages, tools })  ← 同一数组既是历史又是新增
 * B = 修正：runAgentLoop(messages, { messages: [], tools })      ← 历史为空，初始消息只作为新增
 */
import http from "node:http";
import { describe, expect, it } from "vitest";

const PORT = 8897;
const bodies: any[] = [];

function startServer(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const bufs: Buffer[] = [];
		req.on("data", (b) => bufs.push(b));
		req.on("end", () => {
			bodies.push(JSON.parse(Buffer.concat(bufs).toString("utf8")));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				`data: ${JSON.stringify({
					id: "x",
					object: "chat.completion.chunk",
					created: 1,
					model: "m",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
			);
		});
	});
	return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

describe("重复注入的根因与修复", () => {
	it("A 重复 / B 不重复，且 system 只出现一次", async () => {
		const server = await startServer();
		try {
			const { runAgentLoop } = await import("@earendil-works/pi-agent-core");
			const { createModels, createProvider, envApiKeyAuth, lazyApi } = await import("@earendil-works/pi-ai");
			const baseUrl = `http://127.0.0.1:${PORT}/v1`;
			const model = {
				id: "m",
				name: "m",
				api: "openai-completions",
				provider: "demo",
				baseUrl,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1024,
			} as any;
			process.env.DEMO_KEY = "k";
			const models = createModels() as any;
			models.setProvider(
				createProvider({
					id: "demo",
					name: "demo",
					baseUrl,
					auth: { apiKey: envApiKeyAuth("demo", ["DEMO_KEY"]) },
					models: [model],
					api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
				}),
			);
			const resolved = models.getModel("demo", "m") ?? model;
			const streamFn = (m: any, c: any, o: any) => models.streamSimple(m, c, o);

			const tools = [
				{
					label: "get_weather",
					name: "get_weather",
					description: "查询指定城市的当前天气（温度、天气现象）。",
					parameters: {
						type: "object",
						properties: { city: { type: "string", description: "城市名" } },
						required: ["city"],
					},
					execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
				},
			];
			const config = { model: resolved, convertToLlm: (msgs: unknown) => msgs as never[] };
			const mkInitial = () => [
				{ role: "system", content: "SYS_ONCE", timestamp: 1 },
				{ role: "user", content: "USER_ONCE", timestamp: 2 },
			];

			const msgsA = mkInitial();
			await runAgentLoop(msgsA as never, { messages: msgsA, tools } as never, config as never, () => {}, undefined, streamFn as never);

			const msgsB = mkInitial();
			await runAgentLoop(msgsB as never, { messages: [], tools } as never, config as never, () => {}, undefined, streamFn as never);

			const cnt = (b: any, needle: string) => JSON.stringify(b.messages).split(needle).length - 1;
			report("A(Vulcan 现状)", bodies[0], cnt);
			report("B(修正)", bodies[1], cnt);

			expect(cnt(bodies[0], "USER_ONCE")).toBe(2);
			expect(cnt(bodies[1], "USER_ONCE")).toBe(1);
			expect(cnt(bodies[0], "SYS_ONCE")).toBe(2);
			expect(cnt(bodies[1], "SYS_ONCE")).toBe(1);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 60_000);
});

function report(tag: string, body: any, cnt: (b: any, n: string) => number) {
	console.log(`--- ${tag} ---`);
	console.log(JSON.stringify(body.messages, null, 2));
	console.log(`SYS=${cnt(body, "SYS_ONCE")} USER=${cnt(body, "USER_ONCE")} tools=${body.tools?.length ?? 0}`);
}
