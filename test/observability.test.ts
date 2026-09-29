import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { migrateUp } from "../src/server/db/migrate.ts";
import { VulcanAgentLoop, type AgentRunDeps } from "../src/server/agent/index.ts";
import { collectMetrics } from "../src/server/observability/metrics.ts";
import { attributeFailure, attributionDistribution } from "../src/server/observability/attribution.ts";
import { EvalMode } from "../src/server/observability/eval-mode.ts";
import { MemoryStore } from "../src/server/memory/index.ts";
import { MemoryGate } from "../src/server/memory/gate.ts";
import { LangfuseSink, NullSink, agentTraceAdapter, genAiAttributes, type TraceSink, type TraceSpan } from "../src/server/observability/trace.ts";
import type { ToolPlugin, ToolResult } from "../src/server/cordis/index.ts";

// ---------- mock 基建 ----------

function assistantMsg(toolName?: string, call = 1): AssistantMessage {
	const content = toolName
		? [{ type: "toolCall", id: `c-${call}`, name: toolName, arguments: {} } as never]
		: [{ type: "text", text: "done" }];
	return {
		role: "assistant", content, api: "openai-completions", provider: "mock", model: "mock-model",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
		stopReason: toolName ? "toolUse" : "stop", timestamp: Date.now(),
	};
}

function scriptedStreamFn(script: Array<string | null>): AgentRunDeps["streamFn"] {
	let call = 0;
	return (() => {
		const step = script[call];
		call += 1;
		const msg = assistantMsg(step ?? undefined, call);
		const s = new AssistantMessageEventStream();
		s.push({ type: "start", partial: msg } as never);
		s.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg } as never);
		s.end(msg);
		return s;
	}) as never;
}

function makeTool(tool: string, result: () => ToolResult): ToolPlugin {
	return {
		kind: "tool", name: `plugin-${tool}`, tool, description: `mock ${tool}`,
		parameters: { type: "object", properties: {} },
		setup() {}, dispose() {},
		async execute() { return result(); },
	};
}

function seedDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-1', 'alert', 'r1', 'failed', 0, 0)").run();
	db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-2', 'alert', 'r2', 'done', 0, 0)").run();
	return db;
}

// ---------- P4-4 trace ----------

describe("P4-4 Langfuse trace（gen_ai.* 语义）", () => {
	it("agentTraceAdapter：模型调用 span 带 gen_ai.* 属性，工具 span 带名称与耗时", async () => {
		const spans: TraceSpan[] = [];
		const sink: TraceSink = {
			createTrace: () => {},
			addSpan: (s) => spans.push(s),
			endTrace: () => {},
		};
		const adapter = agentTraceAdapter("tr-1", sink, "mock-model");
		const db = seedDb();
		const loop = new VulcanAgentLoop({
			model: { id: "mock-model", api: "openai-completions", provider: "mock", name: "Mock" } as unknown as Model<any>,
			streamFn: scriptedStreamFn(["read_file", null]),
			audit: () => {},
		});
		await loop.run({
			prompt: "fix", systemPrompt: "v",
			tools: [makeTool("read_file", () => ({ ok: true, data: { x: 1 } }))],
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
			onEvent: adapter,
		});
		// gen_ai turn span：gen_ai.request.model + gen_ai.usage.*
		const turn = spans.find((s) => s.name === "gen_ai.turn")!;
		expect(turn).toBeTruthy();
		expect(turn.attributes["gen_ai.request.model"]).toBe("mock-model");
		expect(Number(turn.attributes["gen_ai.usage.input_tokens"])).toBeGreaterThan(0);
		expect(Number(turn.attributes["gen_ai.usage.total_tokens"])).toBe(150);
		expect(Number(turn.attributes["gen_ai.usage.cost"])).toBeCloseTo(0.01);
		// 工具 span
		const toolSpan = spans.find((s) => s.name === "tool.read_file")!;
		expect(toolSpan).toBeTruthy();
		expect(toolSpan.endTime).toBeGreaterThanOrEqual(toolSpan.startTime);
	});

	it("genAiAttributes：纯函数口径（OTel GenAI 约定）", () => {
		const attrs = genAiAttributes("gpt-x", { input: 10, output: 5, cost: { total: 0.2 } });
		expect(attrs["gen_ai.request.model"]).toBe("gpt-x");
		expect(attrs["gen_ai.usage.total_tokens"]).toBe(15);
		expect(attrs["gen_ai.usage.cost"]).toBe(0.2);
	});

	it("LangfuseSink：无密钥退化为 no-op（可观测不阻断主流程）；NullSink 可调用", async () => {
		const sink = new LangfuseSink({});
		expect(() => sink.createTrace("t", "n")).not.toThrow();
		expect(() => new NullSink().addSpan({ traceId: "t", name: "n", startTime: 0, attributes: {} })).not.toThrow();
	});
});

// ---------- P4-5 指标 + 归因 ----------

describe("P4-5 指标采集与失败归因", () => {
	it("collectMetrics：成功率/人工介入率/预算强停率/工具拦截分布", () => {
		const db = seedDb();
		// agent 审计事件：t-1 一次工具拦截 + 预算强停
		const ins = db.prepare(
			"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES ('agent', 0, 'agent', ?, ?, 'ok', ?)",
		);
		ins.run("t-1", "tool_blocked", JSON.stringify({ tool: "deploy_prod" }));
		ins.run("t-1", "budget_exceeded", JSON.stringify({ dimension: "steps" }));
		ins.run("t-1", "tool_blocked", JSON.stringify({ tool: "deploy_prod" }));
		db.prepare("INSERT INTO sessions (task_id, task_state, recent_window) VALUES ('t-1', ?, '[]')").run(
			JSON.stringify({ budget: { steps_used: 12 } }),
		);
		const m = collectMetrics(db);
		expect(m.totalTasks).toBe(2);
		expect(m.successRate).toBeCloseTo(0.5); // 1 done / 2 定稿
		expect(m.budgetStopRate).toBeCloseTo(0.5);
		expect(m.toolBlockedByTool["deploy_prod"]).toBe(2);
		expect(m.avgSteps).toBe(12);
	});

	it("attributeFailure：九类归因的确定性规则（权限越界/无效循环/过早结束/模型异常）", () => {
		// tool_blocked 在案 → permission_violation（最强证据）
		expect(
			attributeFailure([{ kind: "tool_blocked", detail: { tool: "deploy_prod", reason: "not in whitelist" } }], "failed"),
		).toMatchObject({ category: "permission_violation" });
		// 步数超限 + 同工具重复 ≥3 次 → invalid_loop
		const loopEvents = [
			{ kind: "tool_call", detail: { tool: "search_code" } },
			{ kind: "tool_call", detail: { tool: "search_code" } },
			{ kind: "tool_call", detail: { tool: "search_code" } },
			{ kind: "budget_exceeded", detail: { dimension: "steps" } },
		];
		expect(attributeFailure(loopEvents, "failed")).toMatchObject({ category: "invalid_loop" });
		// 零工具调用 → premature_stop
		expect(attributeFailure([], "failed")).toMatchObject({ category: "premature_stop" });
		// 有工具调用、无拦截、无预算事件 → model_error 兜底
		expect(attributeFailure([{ kind: "tool_call", detail: { tool: "read_file" } }], "failed")).toMatchObject({ category: "model_error" });
		// 非失败任务不归因
		expect(attributeFailure([], "done")).toBeNull();
	});

	it("attributionDistribution：从 audit_logs 全量归因出分布", () => {
		const db = seedDb();
		db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-3', 'alert', 'r3', 'rejected', 0, 0)").run();
		const ins = db.prepare(
			"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES ('agent', 0, 'agent', ?, 'tool_blocked', 'ok', ?)",
		);
		ins.run("t-1", JSON.stringify({ tool: "x" }));
		ins.run("t-3", JSON.stringify({ tool: "y" }));
		const dist = attributionDistribution(db);
		expect(dist.permission_violation).toBe(2); // t-1 failed + t-3 rejected 都命中 tool_blocked
	});
});

// ---------- P4-6 评测模式 ----------

describe("P4-6 评测模式开关", () => {
	it("recall_off：召回关闭（不开卷），记忆保留；disable 恢复", () => {
		const db = seedDb();
		new MemoryGate(db).admit({
			content: "约束 A", category: "constraint_decision", source: "task:t-1", project: "svc/auth", verificationStatus: "verified_by_test",
		});
		const store = new MemoryStore(db);
		const em = new EvalMode(db, store);
		em.enable();
		expect(em.validateBaseline()).toMatchObject({ ok: true });
		expect(store.recall({ project: "svc/auth" })).toHaveLength(0); // 召回关闭
		expect(em.status().memoryCount).toBe(1); // 记忆还在
		em.disable();
		expect(store.recall({ project: "svc/auth" })).toHaveLength(1); // 恢复
	});

	it("reset：清空记忆 + 基线校验（残留则拒绝起跑）", () => {
		const db = seedDb();
		new MemoryGate(db).admit({
			content: "约束 B", category: "constraint_decision", source: "task:t-1", project: "svc/auth", verificationStatus: "verified_by_test",
		});
		const store = new MemoryStore(db);
		const em = new EvalMode(db, store);
		// 未开启 → 基线校验拒绝
		expect(em.validateBaseline().ok).toBe(false);
		em.enable({ reset: true });
		expect(em.status()).toMatchObject({ active: true, mode: "reset", memoryCount: 0 });
		expect(em.validateBaseline()).toMatchObject({ ok: true });
		// 开关动作落审计（可追溯）
		const evalAudit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE object_type = 'eval'").get() as { c: number };
		expect(evalAudit.c).toBeGreaterThanOrEqual(1);
	});
});
