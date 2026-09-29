import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { migrateUp } from "../src/server/db/migrate.ts";
import { VulcanAgentLoop } from "../src/server/agent/index.ts";
import { FixPipeline } from "../src/server/agent/fix-pipeline.ts";
import { ApprovalEngine, BUILTIN_DENY_RULES } from "../src/server/approval/engine.ts";
import type { InternalEvent, TaskStatus } from "../src/server/types.ts";
import type { ToolPlugin, ToolResult } from "../src/server/cordis/index.ts";

// ---------- mock 基建（复用 agent-loop 测试的模式） ----------

function assistantMsg(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant", content, api: "openai-completions", provider: "mock", model: "mock-model",
		usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
		stopReason, timestamp: Date.now(),
	};
}

function streamOf(msg: AssistantMessage): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	s.push({ type: "start", partial: msg } as AssistantMessageEvent);
	s.push({ type: "done", reason: msg.stopReason === "toolUse" ? "toolUse" : "stop", message: msg } as AssistantMessageEvent);
	s.end(msg);
	return s;
}

/** 四阶段 ReAct 脚本：复现(read_file)→定位(search_code)→修改(write_file)→测试(run_tests)→收尾 */
function fourStageStreamFn(): { streamFn: ReturnType<typeof makeDeps>["streamFn"]; calls: string[] } {
	const calls: string[] = [];
	const script: Array<{ tool: string; args: Record<string, unknown> } | null> = [
		{ tool: "read_file", args: { path: "src/login.ts" } },          // 复现
		{ tool: "search_code", args: { query: "token verify" } },        // 定位
		{ tool: "write_file", args: { path: "src/login.ts", content: "fixed" } }, // 修改
		{ tool: "run_tests", args: { suite: "auth" } },                  // 测试
		null,                                                            // 收尾
	];
	let call = 0;
	const streamFn = (_m: Model<any>, _c: unknown, _o?: unknown): AssistantMessageEventStream => {
		const step = script[call];
		call += 1;
		if (!step) return streamOf(assistantMsg([{ type: "text", text: "修复完成，补丁与证据已产出" }], "stop"));
		calls.push(step.tool);
		return streamOf(assistantMsg([
			{ type: "toolCall", id: `c-${call}`, name: step.tool, arguments: step.args } as never,
		], "toolUse"));
	};
	return { streamFn: streamFn as never, calls };
}

/** mock 工具：write_file 产出 patchRef，run_tests 产出验证证据 */
function makeTool(tool: string, result: (input: Record<string, unknown>) => ToolResult): ToolPlugin {
	return {
		kind: "tool", name: `plugin-${tool}`, tool, description: `mock ${tool}`,
		parameters: { type: "object", properties: {} },
		setup() {}, dispose() {},
		async execute(input) { return result(input); },
	};
}

function makeDeps(streamFn: unknown, auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = []) {
	return {
		model: { id: "mock-model", api: "openai-completions", provider: "mock", name: "Mock" } as unknown as Model<any>,
		streamFn: streamFn as never,
		audit: (e: { kind: string; detail: Record<string, unknown> }) => auditLog.push(e),
	};
}

function seedTask(taskId = "t-e2e", status: TaskStatus = "running"): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, 'alert', 'fp-e2e', ?, 0, 0)",
	).run(taskId, status);
	return db;
}

const event: InternalEvent = {
	id: "evt-e2e", source: "alert", type: "alert.fired", occurredAt: Date.now(), ref: "fp-e2e", payload: {}, raw: {},
};

function pipeline(db: DatabaseSync, auditLog: Array<{ kind: string; detail: Record<string, unknown> }>): FixPipeline {
	const { streamFn } = fourStageStreamFn();
	const agent = new VulcanAgentLoop(makeDeps(streamFn, auditLog));
	const tools: ToolPlugin[] = [
		makeTool("read_file", () => ({ ok: true, data: { content: "token verify broken" } })),
		makeTool("search_code", () => ({ ok: true, data: { hit: "src/login.ts:42" } })),
		makeTool("write_file", () => ({ ok: true, data: { patchRef: "patch/t-e2e-001.diff" } })),
		makeTool("run_tests", () => ({ ok: true, data: { buildPassed: true, testsPassed: true } })),
	];
	return new FixPipeline({
		db, agent,
		scope: { allowedRepos: ["svc/auth"], forbiddenPaths: ["secrets/**"] },
		tools,
		createPr: async (input) => ({ url: `https://git.example/svc/auth/pull/${input.taskId}` }),
		// 默认策略无 allow 规则（从严永不自动通过），测 approved 链路需注入满足的 allow 规则
		engine: new ApprovalEngine({
			allow: [{ id: "auto-safe", test: (r) => r.evidence.buildPassed && r.evidence.testsPassed, why: "证据不完整" }],
			deny: BUILTIN_DENY_RULES,
		}),
	});
}

describe("P3-7 修复链路端到端贯通", () => {
	it("四阶段全链路：复现→定位→修改→测试→自动审批通过→创建 PR，任务 done", async () => {
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		const db = seedTask();
		const pipe = pipeline(db, auditLog);
		const out = await pipe.run({ taskId: "t-e2e", event, issue: "登录 token 校验失败" });
		expect(out.outcome).toBe("pr_created");
		expect(out.prUrl).toBe("https://git.example/svc/auth/pull/t-e2e");
		expect(out.verdict?.decision).toBe("approved");
		// 任务状态：done
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-e2e'").get() as { status: string }).status).toBe("done");
		// 审批审计落库
		const audit = db.prepare("SELECT * FROM audit_logs WHERE object_type='approval' AND object_id='AP-t-e2e'").get() as Record<string, unknown> | undefined;
		expect(audit).toBeTruthy();
		// session 短期记忆有 4 条工具结果
		const sess = db.prepare("SELECT recent_window FROM sessions WHERE task_id='t-e2e'").get() as { recent_window: string } | undefined;
		expect(sess).toBeTruthy();
		expect(JSON.parse(sess!.recent_window)).toHaveLength(4);
	});

	it("证据缺失（无补丁产出）→ 任务 failed（仅分析建议不冒充修复）", async () => {
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		const db = seedTask();
		const { streamFn } = fourStageStreamFn();
		// 只调 read_file 就收尾（无 write_file → 无 patchRef）
		let call = 0;
		const partialFn = (_m: Model<any>, _c: unknown, _o?: unknown): AssistantMessageEventStream => {
			call += 1;
			if (call === 1) return streamOf(assistantMsg([{ type: "toolCall", id: "c1", name: "read_file", arguments: {} } as never], "toolUse"));
			return streamOf(assistantMsg([{ type: "text", text: "分析完毕，无需修改" }], "stop"));
		};
		const agent = new VulcanAgentLoop(makeDeps(partialFn, auditLog));
		const pipe = new FixPipeline({
			db, agent,
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
			tools: [makeTool("read_file", () => ({ ok: true, data: { content: "x" } }))],
			createPr: async () => ({ url: "should-not-be-called" }),
		});
		const out = await pipe.run({ taskId: "t-e2e", event, issue: "x" });
		expect(out.outcome).toBe("failed");
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-e2e'").get() as { status: string }).status).toBe("failed");
	});

	it("命中禁止项（生产配置）→ 直接驳回，任务 rejected，PR 不创建", async () => {
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		const db = seedTask();
		const { streamFn } = fourStageStreamFn();
		const agent = new VulcanAgentLoop(makeDeps(streamFn, auditLog));
		const tools: ToolPlugin[] = [
			makeTool("read_file", () => ({ ok: true, data: { content: "x" } })),
			makeTool("search_code", () => ({ ok: true, data: {} })),
			makeTool("write_file", () => ({ ok: true, data: { patchRef: "patch/x.diff" } })),
			makeTool("run_tests", () => ({ ok: true, data: { buildPassed: true, testsPassed: true } })),
		];
		let prCalled = false;
		const pipe = new FixPipeline({
			db, agent,
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
			tools,
			createPr: async () => { prCalled = true; return { url: "x" }; },
			// intent 含 prod-config 关键词 → 禁止项驳回
			engine: new ApprovalEngine(),
		});
		// impactScope 含 production → 命中 prod-config 禁止项（规则匹配 /production/i）
		const out = await pipe.run({ taskId: "t-e2e", event, issue: "修改生产数据库连接配置", impactScope: "production-db" });
		expect(out.outcome).toBe("rejected");
		expect(prCalled).toBe(false);
		// 禁止项驳回走独立终态 rejected（不是 failed——failed 留给执行失败）
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-e2e'").get() as { status: string }).status).toBe("rejected");
	});

	it("转人工：证据完整但无 allow 规则 → engine 判 manual → awaiting_manual + 审批单落库", async () => {
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		const db = seedTask();
		const { streamFn } = fourStageStreamFn();
		const agent = new VulcanAgentLoop(makeDeps(streamFn, auditLog));
		const tools: ToolPlugin[] = [
			makeTool("read_file", () => ({ ok: true, data: { content: "x" } })),
			makeTool("search_code", () => ({ ok: true, data: {} })),
			makeTool("write_file", () => ({ ok: true, data: { patchRef: "patch/x.diff" } })),
			// 证据完整（默认策略无 allow 规则 → 不可能自动通过 → manual）
			makeTool("run_tests", () => ({ ok: true, data: { buildPassed: true, testsPassed: true } })),
		];
		const pipe = new FixPipeline({
			db, agent,
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
			tools,
			createPr: async () => ({ url: "nope" }),
		});
		const out = await pipe.run({ taskId: "t-e2e", event, issue: "边界情况修复" });
		expect(out.outcome).toBe("manual_review");
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-e2e'").get() as { status: string }).status).toBe("awaiting_manual");
		// 审批单行存在（flow.ts 回调的 lookup 前提）
		const approval = db.prepare("SELECT * FROM approvals WHERE id='AP-t-e2e'").get() as Record<string, unknown> | undefined;
		expect(approval).toBeTruthy();
		expect(approval!.decision).toBe("manual");
	});

	it("证据不完整（build/test 未过）→ no-evidence 禁止项直接驳回而非转人工", async () => {
		const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
		const db = seedTask();
		const { streamFn } = fourStageStreamFn();
		const agent = new VulcanAgentLoop(makeDeps(streamFn, auditLog));
		const tools: ToolPlugin[] = [
			makeTool("read_file", () => ({ ok: true, data: { content: "x" } })),
			makeTool("search_code", () => ({ ok: true, data: {} })),
			makeTool("write_file", () => ({ ok: true, data: { patchRef: "patch/x.diff" } })),
			makeTool("run_tests", () => ({ ok: true, data: { buildPassed: false, testsPassed: false } })), // 证据不完整
		];
		const pipe = new FixPipeline({
			db, agent,
			scope: { allowedRepos: ["svc/auth"], forbiddenPaths: [] },
			tools,
			createPr: async () => ({ url: "nope" }),
		});
		const out = await pipe.run({ taskId: "t-e2e", event, issue: "x" });
		expect(out.outcome).toBe("rejected");
		expect(out.verdict?.matchedDeny).toContain("no-evidence");
	});
});
