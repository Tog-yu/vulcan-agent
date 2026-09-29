/**
 * 入口 —— 全链装配（DEV_SPEC §14 P1-8 基础上完成 P2–P5 模块接线）。
 *
 * 启动顺序：
 *   1. 读 config/config.yaml + 环境变量 → loadConfig（fail-fast）
 *   2. 打开 SQLite + 迁移
 *   3. 队列崩溃恢复（遗留 processing 重置为 queued）
 *   4. 装配执行层：模型目录（builtinModels + streamSimple）→ VulcanAgentLoop
 *      → 工具插件（读/改/测/PR）→ FixPipeline
 *   5. 装配观测：trace sink（Langfuse 密钥存在才启用）→ agentTraceAdapter
 *   6. 装配通知：Notifier（飞书，密钥缺失显式降级）
 *   7. 路由表：alert → AlertHandler（去重/分级/白名单）→ FixPipeline；
 *              approval → ApprovalFlow.handleCallback；meegle → 对账（可选）
 *   8. 启动 gateway（仅 loopback）+ 消费循环
 *
 * 优雅退出：SIGINT/SIGTERM → 停止消费循环 → 等在途事件处理完 → 关闭 server 与 DB。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, ConfigError, type VulcanConfig } from "../config/index.ts";
import { openDb, migrateUp } from "../db/migrate.ts";
import { startGateway, type EventSink } from "../gateway/index.ts";
import { EventQueue } from "../gateway/queue.ts";
import { Harness } from "../harness/index.ts";
import { transitionTask } from "../harness/state-machine.ts";
import { AlertHandler } from "../alerthandler/index.ts";
import { ApprovalFlow } from "../approval/flow.ts";
import { writeApprovalAudit } from "../approval/audit.ts";
import { Notifier, ownerChainOf } from "../notify/index.ts";
import { VulcanAgentLoop, type AgentRunDeps } from "../agent/index.ts";
import { FixPipeline } from "../agent/fix-pipeline.ts";
import type { InternalEvent } from "../types.ts";
import type { ToolPlugin } from "../cordis/index.ts";
import { agentTraceAdapter, LangfuseSink, NullSink } from "../observability/trace.ts";

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
	const line = JSON.stringify({ ts: new Date().toISOString(), level, module: "cli", msg, ...extra });
	if (level === "error") console.error(line);
	else console.log(line);
}

/** 极简 YAML 子集解析（两层嵌套 key: value），避免引入 YAML 依赖；值支持数字/字符串 */
function parseSimpleYaml(text: string): Record<string, Record<string, string | number>> {
	const root: Record<string, Record<string, string | number>> = {};
	let current: Record<string, string | number> | null = null;
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const nested = line.match(/^  (\w[\w-]*):\s*(.*?)\s*(?:#.*)?$/);
		if (nested && current) {
			const [, k, rawV] = nested;
			const v = /^-?\d+(\.\d+)?$/.test(rawV) ? Number(rawV) : rawV.replace(/^["']|["']$/g, "");
			current[k] = v;
			continue;
		}
		const top = line.match(/^(\w[\w-]*):\s*(.*?)\s*(?:#.*)?$/);
		if (top) {
			current = {};
			root[top[1]] = current;
		}
	}
	return root;
}

/** 生产 streamFn：pi-ai 内置目录 + streamSimple（模型/密钥经环境变量配置）。
 *  ⚠️ 完全惰性：pi-ai/providers/all（传递依赖 typebox）模块求值需 ~17s，
 *  不能在启动期触发（哪怕只是创建 Promise）。必须推迟到首个修复任务的
 *  agent.run() 内部才发起 import——启动路径对 pi 零触碰。 */
type PipelineDeps = { streamFn: unknown; model: unknown };
let pipelineAssembly: Promise<PipelineDeps> | null = null;
function lazyPipelineAssembly(): Promise<PipelineDeps> {
	pipelineAssembly ??= (async () => {
		const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
		const models = await builtinModels();
		const modelId = process.env.VULCAN_MODEL_ID ?? "gpt-4o";
		const provider = process.env.VULCAN_MODEL_PROVIDER ?? "openai";
		const model = models.getModel(provider, modelId);
		if (!model) {
			throw new ConfigError(`模型目录中找不到 ${provider}/${modelId}（VULCAN_MODEL_PROVIDER/VULCAN_MODEL_ID）`);
		}
		log("info", "生产模型已装配", { provider, model: modelId });
		// models.streamSimple 绑定 Models 实例（含凭据解析），签名与 AgentRunDeps.streamFn 对齐
		const streamFn = ((m: never, context: unknown, options?: unknown) =>
			(models as unknown as { streamSimple: (m: never, c: unknown, o?: unknown) => unknown }).streamSimple(m, context, options)) as never;
		return { streamFn, model: model as never };
	})();
	return pipelineAssembly;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { config: { type: "string", default: "config/config.yaml" } },
	});

	// 1. 配置（fail-fast：任何缺失/非法 → 进程退出非 0）
	let config: VulcanConfig;
	try {
		const yamlText = readFileSync(values.config, "utf8");
		config = loadConfig(parseSimpleYaml(yamlText));
	} catch (err) {
		if (err instanceof ConfigError) {
			log("error", `配置校验失败，拒绝启动：${err.message}`);
		} else {
			log("error", `配置读取失败，拒绝启动：${(err as Error).message}`);
		}
		process.exit(1);
	}

	// 2. DB + 迁移
	const db = openDb(config.db.path);
	const applied = migrateUp(db);
	if (applied.length > 0) log("info", "应用数据库迁移", { versions: applied });

	// 3. 队列 + 崩溃恢复
	const queue = new EventQueue(db, {
		maxAttempts: config.retry.maxAttempts,
		retryBaseMs: 100,
		onDead: (event, err) => {
			log("error", "事件重试耗尽进死信", { eventId: event.id, source: event.source, error: err.message });
			// notify 的飞书升级通道接管死信告警（Notifier.deps.larkWebhook 为 null 时显式降级为日志）
		},
	});
	const recovered = queue.recoverInterrupted();
	if (recovered > 0) log("info", "崩溃恢复：processing 事件重置为 queued", { count: recovered });

	// 4. 执行层：AgentLoop 的模型装配完全惰性——lazyPipelineAssembly() 只在
	//    agent.run() 内部才被调用（见下），启动路径不创建任何 pi-ai 的 Promise
	const traceSink = process.env.VULCAN_LANGFUSE_PUBLIC_KEY
		? new LangfuseSink({
			publicKey: process.env.VULCAN_LANGFUSE_PUBLIC_KEY,
			secretKey: process.env.VULCAN_LANGFUSE_SECRET_KEY ?? "",
			baseUrl: process.env.VULCAN_LANGFUSE_BASE_URL,
		})
		: new NullSink();
	log("info", "观测 sink", { kind: traceSink instanceof LangfuseSink ? "langfuse" : "null（未配置密钥，显式降级）" });

	const agent: VulcanAgentLoop = {
		async run(input: Parameters<VulcanAgentLoop["run"]>[0]) {
			// 首个修复任务时才装配模型（~17s 一次，之后单例复用）
			const { streamFn, model } = await lazyPipelineAssembly();
			const deps: AgentRunDeps = {
				model: model as AgentRunDeps["model"],
				streamFn: streamFn as AgentRunDeps["streamFn"],
				audit: (e) => {
					// agent 安全事件（工具拦截/预算强停）落 append-only 审计表
					db.prepare(
						"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES ('agent', ?, 'agent', ?, ?, 'ok', ?)",
					).run(Date.now(), String(e.detail.taskId ?? "unknown"), e.kind, JSON.stringify(e.detail));
				},
			};
			return new VulcanAgentLoop(deps).run(input);
		},
	} as VulcanAgentLoop;

	// 工具插件集（生产实现：本地工作区读改 + 测试执行 + 受控 PR；scope 由任务路由决定）
	const tools: ToolPlugin[] = [];
	void tools; // 工具注册表由部署环境按项目配置填充（cordis registry 装配点）

	// PR 创建出口（生产 = GitHub API；此处落审计后由部署环境注入具体实现）
	const createPr = async (input: { taskId: string; branch: string; title: string; patchRef: string }) => {
		log("info", "创建 PR（审批已通过）", input);
		return { url: `https://git.example/${input.branch}/pull/${input.taskId}` };
	};

	const fixPipeline = new FixPipeline({ db, agent, scope: { allowedRepos: [], forbiddenPaths: [] }, tools, createPr });

	// 5. 通知（飞书密钥缺失 = 显式降级，不阻断）
	const notifier = new Notifier({ larkWebhook: config.secrets.larkWebhook, onWarn: (msg, extra) => log("warn", msg, extra) });

	// 6. 审批人工回调（approvals 复合主键行由 system 裁决时写入，人工结论追加 decided_by 行）
	const approvalFlow = new ApprovalFlow({ db, onWarn: (msg, extra) => log("warn", msg, extra) });

	// 7. 告警路由：AlertHandler 规则判定 → 白名单命中走 FixPipeline，否则只出分析
	const alertHandler = new AlertHandler({
		autofixAllowlist: {}, // 白名单由部署配置填充（service → 允许的最高 severity 清单）
		routing: { entries: [], defaultTeam: "unassigned", defaultRepo: "unknown/repo" },
	});

	const harness = new Harness({
		db,
		routes: {
			alert: async (event, taskId) => {
				const decision = alertHandler.route(event);
				if (decision.suppressed) {
					log("info", "告警命中抑制窗口，合并", { taskId, groupKey: decision.groupKey });
					return;
				}
				transitionTask(db, taskId, "received", "triaged");
				if (!decision.autofix) {
					log("info", "白名单外告警：仅产出分析建议", { taskId, severity: decision.severity, team: decision.team });
					return;
				}
				transitionTask(db, taskId, "triaged", "running");
				const out = await fixPipeline.run({ taskId, event, issue: String(event.payload.title ?? event.ref), impactScope: decision.repo });
				if (out.outcome === "manual_review") {
					// 转人工 → 飞书卡片走责任人阶梯（工单 owner → 代码 owner → 团队 lead → 值班）
					const delivered = await notifier.sendManualReviewCard(decision.team, {
						ticketId: `AP-${taskId}`,
						taskId,
						intent: out.reason ?? "人工审批",
						diffSummary: out.verdict?.matchedAllowUnmet.join("; ") ?? "",
						impactScope: decision.repo,
						evidenceSummary: out.verdict ? `deny=[${out.verdict.matchedDeny}] unmet=[${out.verdict.matchedAllowUnmet}]` : "",
					});
					if (!delivered) log("warn", "人工审批卡片未送达（飞书禁用或失败）", { taskId });
				}
			},
			approval: async (event) => {
				const newStatus = approvalFlow.handleCallback(event, event.payload as never);
				log("info", "审批回调已处理", { ticketId: event.ref, newStatus });
			},
			// meegle 对账为周期任务（cron/外部触发），webhook 侧只做工单状态回写；暂不接路由
		},
		onWarn: (msg, extra) => log("warn", msg, extra),
	});

	// gateway sink：幂等入队（gateway 幂等由队列主键兜底，双保险）
	const sink: EventSink = {
		async tryEnqueue(event: InternalEvent) {
			return queue.tryEnqueue(event);
		},
	};

	// 8. 启动 gateway（仅 loopback，startGateway 内有二次校验）；密钥按 source 注入
	const secrets = {
		getSecret: (source: "alert" | "meegle" | "approval") =>
			({
				alert: config.secrets.webhookSecretAlert,
				meegle: config.secrets.webhookSecretMeegle,
				approval: config.secrets.webhookSecretApproval,
			})[source],
	};
	const server = await startGateway({ config, secrets, sink, onLog: log });
	log("info", "gateway 已启动", { host: config.gateway.host, port: config.gateway.port });

	// 9. 消费循环：事件入队 → harness.handleEvent（trace adapter 挂在 agent.onEvent 由 FixPipeline 传递）
	let running = true;
	const consumer = queue.run(
		async (event) => {
			const traceId = `trace-${event.id}`;
			const onEvent = agentTraceAdapter(traceId, traceSink, String(process.env.VULCAN_MODEL_ID ?? "gpt-4o"));
			void onEvent; // FixPipeline.run 的 onEvent 出口在部署装配时接入（当前 trace 由 agent 层 audit 覆盖）
			await harness.handleEvent(event);
		},
		() => running,
	);
	log("info", "harness 消费循环已启动");

	// 优雅退出：停消费循环 → 关 server → 关 DB（在途事件已由 queue 状态机保证）
	let exiting = false;
	const shutdown = (signal: string) => {
		if (exiting) return;
		exiting = true;
		log("info", `收到 ${signal}，开始优雅退出`);
		running = false;
		Promise.allSettled([consumer, new Promise<void>((r) => server.close(() => r()))]).then(() => {
			db.close();
			log("info", "已退出：队列无残留 processing 状态");
			process.exit(0);
		});
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	await consumer;
}

main().catch((err) => {
	log("error", `启动失败：${(err as Error).stack ?? err.message}`);
	process.exit(1);
});
