/**
 * 入口 —— 装配 config → gateway → queue → harness（DEV_SPEC §14 P1-8）。
 *
 * 启动顺序：
 *   1. 读 config/config.yaml + 环境变量 → loadConfig（fail-fast）
 *   2. 打开 SQLite + 迁移
 *   3. 队列崩溃恢复（遗留 processing 重置为 queued）
 *   4. 启动 gateway（仅 loopback）
 *   5. 启动 harness 消费循环
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
import type { InternalEvent } from "../types.ts";

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
			// P2 接飞书告警（notify），当前只落 ERROR 日志（DEV_SPEC §11 P1 告警挂点）
		},
	});
	const recovered = queue.recoverInterrupted();
	if (recovered > 0) log("info", "崩溃恢复：processing 事件重置为 queued", { count: recovered });

	// 4. Harness（P1 阶段路由为空壳：建任务 + 推进 received→triaged 留给 P2 handler）
	const harness = new Harness({
		db,
		routes: {},
		onWarn: (msg, extra) => log("warn", msg, extra),
	});

	// gateway sink：幂等入队（gateway 幂等由队列主键兜底，双保险）
	const sink: EventSink = {
		async tryEnqueue(event: InternalEvent) {
			return queue.tryEnqueue(event);
		},
	};

	// 5. 启动 gateway（仅 loopback，startGateway 内有二次校验）；密钥按 source 注入
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

	// 6. 消费循环：事件入队 → harness.handleEvent
	let running = true;
	const consumer = queue.run(
		async (event) => {
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
