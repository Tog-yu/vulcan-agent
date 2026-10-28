/**
 * oMLX 真模型端到端冒烟（开发脚本，非 vitest 用例）。
 *
 * 用本地 oMLX（Qwen3.6-35B-A3B-mxfp4）作为 AgentLoop 的 streamFn，
 * 走 vulcan 完整修复流程：
 *   webhook 事件 → FixPipeline 编排 → AgentLoop ReAct（复现→定位→修改→测试）
 *   → 真模型驱动真工具（read_file/search_code/write_file/run_tests）
 *   → 审批裁决 → PR 创建 → 定稿提炼（distill → 门禁 → fake RAG）
 *
 * 运行：
 *   OMLX_API_KEY=1234 node --experimental-strip-types scripts/e2e-omlx.ts
 *
 * 产物：data/e2e-omlx.db（持久 SQLite，供测试报告展示各表记录）+ 控制台全流程日志。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assembleOmlxPipeline } from "../src/server/cli/omlx-model.ts";
import { migrateUp } from "../src/server/db/migrate.ts";
import { VulcanAgentLoop } from "../src/server/agent/index.ts";
import { FixPipeline } from "../src/server/agent/fix-pipeline.ts";
import { ApprovalEngine, BUILTIN_DENY_RULES } from "../src/server/approval/engine.ts";
import { MemoryStore } from "../src/server/memory/index.ts";
import { distillFromTask } from "../src/server/memory/distill.ts";
import { createCordisRuntime } from "../src/server/cordis/bootstrap.ts";
import { createBuiltinToolPlugins } from "../src/server/cordis/builtin-tools.ts";
import { LocalRetrievalPlugin, contentHashOf, type CandidateSource, type RetrievalQuery } from "../src/server/cordis/retrieval.ts";
import { LangfuseSink, agentTraceAdapter } from "../src/server/observability/trace.ts";
import type { InternalEvent } from "../src/server/types.ts";
import type { ToolPlugin } from "../src/server/cordis/index.ts";
import { FakeRagServer } from "../test/helpers/fake-rag-server.ts";

const DB_PATH = join(process.cwd(), "data", "e2e-omlx.db");

function log(step: string, msg: string, extra?: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), step, msg, ...extra }));
}

/** 临时工作区：一个带 bug 的"项目"，模型要读它、定位、修改、跑测试 */
function makeWorkspace(): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "vulcan-e2e-ws-"));
	mkdirSync(join(root, "svc/auth/src"), { recursive: true });
	writeFileSync(
		join(root, "svc/auth/src/login.ts"),
		[
			"// 登录 token 校验（演示项目）",
			"export function verifyToken(token: string): boolean {",
			"  // BUG: 过期判断写反了——过期 token 反而被放行",
			"  if (Date.now() < Number(token.split('_')[1] ?? 0)) {",
			"    return true;",
			"  }",
			"  return false;",
			"}",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(root, "svc/auth/src/index.ts"),
		["import { verifyToken } from './login.ts';", "export const authApi = { verifyToken };", ""].join("\n"),
	);
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 检索候选源：索引了工作区的两个文件（相关性按 query 词命中数） */
function makeCandidateSource(): CandidateSource {
	const index = [
		{
			repo: "svc/auth", branch: "main", filePath: "src/login.ts", commit: "abc123",
			contentHash: contentHashOf("login"),
			snippet: "verifyToken 过期判断逻辑（login.ts 全文）", score: 2,
		},
		{
			repo: "svc/auth", branch: "main", filePath: "src/index.ts", commit: "abc123",
			contentHash: contentHashOf("index"),
			snippet: "authApi 出口定义", score: 1,
		},
	];
	return {
		async search(query: RetrievalQuery) {
			const terms = query.text.toLowerCase().split(/\s+/).filter(Boolean);
			return index
				.map((c) => ({
					...c,
					score: terms.reduce((n, t) => n + (c.snippet.toLowerCase().includes(t) ? 1 : 0), 0) || c.score,
				}))
				.filter((c) => query.allowedRepos.includes(c.repo))
				.sort((a, b) => b.score - a.score);
		},
	};
}

async function main(): Promise<void> {
	if (!process.env.OMLX_API_KEY) {
		console.error("缺少 OMLX_API_KEY（oMLX 默认 1234）");
		process.exit(1);
	}
	const ws = makeWorkspace();
	mkdirSync(join(process.cwd(), "data"), { recursive: true });
	rmSync(DB_PATH, { force: true });

	// —— DB + 迁移 ——
	const db = new DatabaseSync(DB_PATH);
	const applied = migrateUp(db);
	log("db", "迁移完成", { versions: applied, path: DB_PATH });

	// —— 模型（oMLX 真调用） ——
	const t0 = Date.now();
	const { streamFn, model } = await assembleOmlxPipeline();
	log("model", "oMLX 管线已装配", {
		model: model.id,
		provider: model.provider,
		baseUrl: model.baseUrl,
		装配耗时ms: Date.now() - t0,
	});

	// —— Cordis 执行层：真工具插件（read/write 直接落临时工作区；run_tests 教学版） ——
	// 口径对齐：工具的 assertInScope = resolve(workspaceRoot, path) 必须以
	// resolve(workspaceRoot, repo) 为前缀。workspaceRoot 指仓库本身 + allowedRepos=["."]
	// （仓库即根），模型的相对路径 "src/login.ts" 才能通过前缀检查。
	// 若 allowedRepos=["svc/auth"] 而 root 已是仓库根，任何相对路径都越权（首跑教训）。
	const repoRoot = join(ws.root, "svc/auth");
	const pluginCtx = {
		log: (msg: string, extra?: Record<string, unknown>) => log("cordis", msg, extra),
		workspaceRoot: repoRoot,
		allowedRepos: ["."],
	};
	const runtime = await createCordisRuntime(createBuiltinToolPlugins(pluginCtx), pluginCtx);
	log("cordis", "工具插件就绪", { tools: runtime.tools.list().map((t) => t.tool) });

	// 检索插件（本地索引形态）
	const retrieval = new LocalRetrievalPlugin(makeCandidateSource(), { maxResults: 3 });
	retrieval.setup(pluginCtx);

	// run_tests 内置插件是占位实现（恒 false）——替换为教学版：
	// 传入 shell 特征（find/ls/cat/grep...）时拒绝并提示正确工具，防止模型把
	// run_tests 当 shell 用（首跑教训：恒通过的占位实现会主动强化错误用法）。
	const tools: ToolPlugin[] = runtime.tools.list().map((t) =>
		t.tool === "run_tests"
			? {
				...t,
				async execute(input) {
					const suite = String(input.suite ?? "");
					const shellLike = /[;|]|\bfind\b|\bls\b|\bcat\b|\bgrep\b|\bpwd\b|\bglob\b|\bhead\b/.test(suite);
					if (shellLike) {
						log("tool", "run_tests 拒绝 shell 特征输入", { suite });
						return {
							ok: true,
							data: {
								suite,
								testsPassed: false,
								buildPassed: false,
								note: "run_tests 只执行测试套件（如 npm test），不接受 shell 命令。读文件请用 read_file 工具，写文件请用 write_file 工具。",
							},
						};
					}
					log("tool", "run_tests（通过）", { suite });
					return { ok: true, data: { suite, testsPassed: true, buildPassed: true } };
				},
			}
			: t,
	);

	// —— AgentLoop（真 streamFn）+ 审计 ——
	const auditLog: Array<{ kind: string; detail: Record<string, unknown> }> = [];
	const agent = new VulcanAgentLoop({
		model,
		streamFn: streamFn as never,
		audit: (e) => {
			auditLog.push(e);
			db.prepare(
				"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES ('agent', ?, 'agent', ?, ?, 'ok', ?)",
			).run(Date.now(), "t-omlx", e.kind, JSON.stringify(e.detail));
		},
	});

	// —— FixPipeline（审批策略：测试证据完整即 allow） ——
	// scope.allowedRepos 必须与工具插件的 allowedRepos 口径一致——
	// 前者约束 FixPipeline 审批的 impactScope，后者约束工具路径越权检查
	const pipe = new FixPipeline({
		db,
		agent: agent as never,
		// 与 pluginCtx.allowedRepos 同口径：工具的 assertInScope 用同一个 scope 对象判定
		scope: { allowedRepos: ["."], forbiddenPaths: ["secrets/**"] },
		tools,
		retrieval,
		createPr: async (input) => {
			log("pr", "PR 已创建（审批通过）", input);
			return { url: `https://git.example/svc/auth/pull/${input.taskId}` };
		},
		engine: new ApprovalEngine({
			allow: [{ id: "auto-safe", test: (r) => r.evidence.buildPassed && r.evidence.testsPassed, why: "证据不完整" }],
			deny: BUILTIN_DENY_RULES,
		}),
	});

	// —— 种子任务（webhook 事件已入队并路由到 running 的形态） ——
	db.prepare("INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-omlx', 'alert', 'omlx-e2e', 'running', ?, ?)").run(Date.now(), Date.now());
	db.prepare(
		"INSERT INTO webhook_events (id, source, type, occurred_at, ref, payload, raw, received_at, status, attempts) VALUES (?, 'alert', 'alert.fired', ?, 'omlx-e2e', '{}', '{}', ?, 'done', 0)",
	).run("evt-omlx", Date.now(), Date.now());

	const event: InternalEvent = {
		id: "evt-omlx", source: "alert", type: "alert.fired", occurredAt: Date.now(), ref: "omlx-e2e", payload: {}, raw: {},
	};

	// —— 跑完整修复流程 ——
	// issue 带疑似位置：对齐真实告警形态（堆栈/文件坐标随告警 payload 下来）。
	// 无定位信息的告警会让模型盲探索（首跑教训：把 run_tests 当 shell 用，25 步烧完强停）。
	// —— Langfuse 全链路 trace：sink 按环境变量装配（密钥缺失 → NullSink，不阻断） ——
	const lfSink = process.env.VULCAN_LANGFUSE_PUBLIC_KEY
		? new LangfuseSink({
			publicKey: process.env.VULCAN_LANGFUSE_PUBLIC_KEY,
			secretKey: process.env.VULCAN_LANGFUSE_SECRET_KEY ?? "",
			baseUrl: process.env.VULCAN_LANGFUSE_BASE_URL ?? "http://localhost:3000",
		})
		: null;
	log("trace", lfSink ? "Langfuse sink 已装配" : "Langfuse 未配置，trace 降级 no-op", {
		publicKey: process.env.VULCAN_LANGFUSE_PUBLIC_KEY ?? "(unset)",
		baseUrl: process.env.VULCAN_LANGFUSE_BASE_URL ?? "http://localhost:3000",
	});
	const traceId = `trace-e2e-omlx-${Date.now()}`;
	const onEvent = lfSink ? agentTraceAdapter(traceId, lfSink, model.id) : undefined;

	const runStart = Date.now();
	const out = await pipe.run({
		taskId: "t-omlx",
		event,
		onEvent,
		issue: "登录 token 校验失败：过期 token 被放行。请先用 read_file 工具读取 src/login.ts 确认 verifyToken 函数的过期判断逻辑，然后用 write_file 工具修复该判断，最后用 run_tests 工具执行 npm test 验证。禁止直接在回答中给出修改方案——必须通过工具执行。",
	});
	log("pipeline", "FixPipeline 完成", { ...out, 总耗时ms: Date.now() - runStart });

	// Langfuse SDK 异步批量上报：flush 后再退出，丢 trace 的经典坑
	if (lfSink) {
		await lfSink.flush();
		log("trace", "Langfuse 已 flush", { traceId });
	}

	// —— 定稿提炼（长期记忆链路：distill → 门禁 → RAG store） ——
	const fakeRag = new FakeRagServer();
	const memory = new MemoryStore({ rag: { transport: "stdio" }, clientFactory: fakeRag.factory() });
	const distill = await distillFromTask(db, "t-omlx", "svc/auth", memory);
	log("memory", "定稿提炼完成", { ...distill });

	// 召回验证（写入的东西要能被检索回来）
	const recalled = await memory.recall({ project: "svc/auth", query: "token" });
	log("memory", "召回验证", { 条数: recalled.length, 首条: recalled[0]?.content.slice(0, 60) });

	// —— 全流程报告：dump 各表 ——
	console.log("\n========== 表数据快照 ==========");
	for (const table of ["schema_migrations", "webhook_events", "tasks", "task_events", "sessions", "approvals", "audit_logs"]) {
		const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
		console.log(`\n--- ${table} (${rows.length} 行) ---`);
		for (const row of rows.slice(0, 6)) {
			const slim: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) {
				const s = typeof v === "string" ? v : String(v);
				slim[k] = s.length > 160 ? s.slice(0, 160) + "…" : v;
			}
			console.log(JSON.stringify(slim));
		}
	}
	console.log("\n========== RAG 分区（fake server, project=svc/auth） ==========");
	console.log(JSON.stringify(fakeRag.recordsOf("svc/auth"), null, 1));

	// agent 审计事件汇总
	console.log("\n========== agent 审计事件 ==========");
	console.log(JSON.stringify(auditLog, null, 1).slice(0, 1500));

	// 收尾
	await runtime.dispose();
	db.close();
	ws.cleanup();
	log("done", "E2E 冒烟结束", { dbPath: DB_PATH });
}

main().catch((err) => {
	console.error("E2E 失败：", err);
	process.exit(1);
});
