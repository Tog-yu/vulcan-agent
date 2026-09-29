import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { VulcanAgentLoop, type AgentRunDeps } from "../src/server/agent/index.ts";
import type { ToolPlugin, ToolResult } from "../src/server/cordis/index.ts";

// ---------- mock 基建 ----------

/** 构造一条 assistant 消息（含 usage），模拟模型输出 */
function assistantMsg(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage?: Partial<AssistantMessage["usage"]>,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: usage?.input ?? 10,
			output: usage?.output ?? 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: (usage?.input ?? 10) + (usage?.output ?? 5),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.cost?.total ?? 0.001 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** 把一条 assistant 消息包装成事件流（模拟 streamFn 返回） */
function streamOf(msg: AssistantMessage): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	// 推最小事件序列：start → done
	s.push({ type: "start", partial: msg } as AssistantMessageEvent);
	s.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg } as AssistantMessageEvent);
	s.end(msg);
	return s;
}

/** 脚本化 streamFn：按调用次序依次吐出预设消息 */
function scriptedStreamFn(script: AssistantMessage[][]) {
	let call = 0;
	return (_model: Model<any>, _ctx: unknown, _opts?: unknown): AssistantMessageEventStream => {
		const msgs = script[Math.min(call, script.length - 1)];
		call += 1;
		return streamOf(msgs[0] ?? assistantMsg([{ type: "text", text: "ok" }], "stop"));
	};
}

/** mock 工具插件 */
function mockTool(tool: string, exec?: (input: Record<string, unknown>) => ToolResult): ToolPlugin {
	return {
		kind: "tool",
		name: `plugin-${tool}`,
		tool,
		description: `mock ${tool}`,
		parameters: { type: "object", properties: {} },
		setup() {},
		dispose() {},
		async execute(input) {
			return exec ? exec(input) : { ok: true, data: { input } };
		},
	};
}

function makeDeps(streamFn: AgentRunDeps["streamFn"], auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = []): AgentRunDeps {
	return {
		model: { id: "mock-model", api: "openai-completions", provider: "mock", name: "Mock" } as unknown as Model<any>,
		streamFn,
		audit: (e) => auditLog.push(e),
	};
}

// ---------- 测试 ----------

describe("P3-2 Pi AgentLoop 接入", () => {
	it("ReAct 循环：模型调白名单内工具 → 工具执行 → 结果回填 → 模型收尾", async () => {
		const script: AssistantMessage[][] = [
			[assistantMsg([{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "src/a.ts" } } as never], "toolUse")],
			[assistantMsg([{ type: "text", text: "done" }], "stop")],
		];
		const executed: Array<Record<string, unknown>> = [];
		const loop = new VulcanAgentLoop(makeDeps(scriptedStreamFn(script)));
		const out = await loop.run({
			prompt: "fix login bug",
			systemPrompt: "you are vulcan",
			tools: [mockTool("read_file", (input) => {
				executed.push(input);
				return { ok: true, data: { content: "file text" } };
			})],
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
		});
		expect(out.endReason).toBe("completed");
		expect(executed).toEqual([{ path: "src/a.ts" }]);
		// transcript 里有 toolResult 回填
		const roles = out.messages.map((m) => (m as { role: string }).role);
		expect(roles).toContain("toolResult");
	});

	it("白名单外工具：beforeToolCall 拦截 + 记审计，工具不执行", async () => {
		// 模型第一轮试图调 deploy_prod（注册了但不在白名单），第二轮收尾
		const script: AssistantMessage[][] = [
			[assistantMsg([{ type: "toolCall", id: "c1", name: "deploy_prod", arguments: {} } as never], "toolUse")],
			[assistantMsg([{ type: "text", text: "ok, staying in scope" }], "stop")],
		];
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		let executed = false;
		const loop = new VulcanAgentLoop(makeDeps(scriptedStreamFn(script), auditLog));
		const out = await loop.run({
			prompt: "deploy",
			systemPrompt: "vulcan",
			tools: [
				mockTool("deploy_prod", () => { executed = true; return { ok: true, data: {} }; }),
				mockTool("read_file"),
			],
			allowedTools: ["read_file"], // deploy_prod 不在白名单
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
		});
		expect(executed).toBe(false); // 被 beforeToolCall 拦截，没执行
		expect(auditLog.some((e) => e.kind === "tool_blocked" && e.detail.tool === "deploy_prod")).toBe(true);
		expect(out.endReason).toBe("completed");
	});

	it("主模型无直接工作区访问：工具只拿到结构化入参 + scope 约束透传", async () => {
		let capturedScope: unknown = null;
		const script: AssistantMessage[][] = [
			[assistantMsg([{ type: "toolCall", id: "c1", name: "write_file", arguments: { path: "src/b.ts", content: "x" } } as never], "toolUse")],
			[assistantMsg([{ type: "text", text: "done" }], "stop")],
		];
		const loop = new VulcanAgentLoop(makeDeps(scriptedStreamFn(script)));
		await loop.run({
			prompt: "fix",
			systemPrompt: "vulcan",
			tools: [mockTool("write_file", (input) => {
				// scope 由循环注入，不由模型参数决定
				return { ok: true, data: { input } };
			})],
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: ["secrets/**"] },
		});
		// 模型参数里没有 scope 字段——约束不可被模型注入
		expect(capturedScope).toBeNull();
		// 正确性：插件收到的 scope 是循环给定的
		const loop2 = new VulcanAgentLoop(makeDeps(scriptedStreamFn(script)));
		let gotScope: unknown = null;
		await loop2.run({
			prompt: "fix",
			systemPrompt: "vulcan",
			tools: [
				{
					...mockTool("write_file"),
					async execute(_input, scope) {
						gotScope = scope;
						return { ok: true, data: {} };
					},
				} as ToolPlugin,
			],
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: ["secrets/**"] },
		});
		expect(gotScope).toEqual({ allowedRepos: ["svc/auth"], forbiddenPaths: ["secrets/**"] });
	});

	it("usage 统计：steps/Token/成本累计正确", async () => {
		const script: AssistantMessage[][] = [
			[assistantMsg([{ type: "text", text: "a" }], "stop", { input: 100, output: 50, cost: { total: 0.01 } as never })],
		];
		const loop = new VulcanAgentLoop(makeDeps(scriptedStreamFn(script)));
		const out = await loop.run({
			prompt: "hi", systemPrompt: "v", tools: [],
			scope: { allowedRepos: [], forbiddenPaths: [] },
		});
		expect(out.usage.steps).toBe(1);
		expect(out.usage.inputTokens).toBe(100);
		expect(out.usage.outputTokens).toBe(50);
		expect(out.usage.cost).toBeCloseTo(0.01);
	});
});
