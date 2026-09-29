/**
 * 配置加载 —— 对齐 DEV_SPEC §9。
 *
 * 约定：
 *   - config/config.yaml 放非敏感配置；密钥只走环境变量
 *   - 环境变量清单：VULCAN_WEBHOOK_SECRET_{ALERT|MEEGLE|APPROVAL}、
 *     VULCAN_MEEGLE_PLUGIN_TOKEN、VULCAN_MEEGLE_USER_KEY、VULCAN_LARK_WEBHOOK
 *   - fail-fast：必填密钥缺失 / gateway.host 非 loopback / db.path 父目录不可写 → 启动即退出
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface GatewayConfig {
	/** 硬约束：仅 loopback；对外暴露须经 reverse proxy（config/config.yaml:4） */
	host: string;
	port: number;
	maxBodyBytes: number;
}

export interface MeegleConfig {
	baseUrl: string;
}

export interface DbConfig {
	path: string;
}

export interface AgentConfig {
	maxSteps: number;
	tokenBudget: number;
	costUsdBudget: number;
}

export interface SessionConfig {
	summaryEverySteps: number;
	summaryAtBudgetPct: number;
}

export interface RetryConfig {
	maxAttempts: number;
}

export interface Secrets {
	webhookSecretAlert: string;
	webhookSecretMeegle: string;
	webhookSecretApproval: string;
	meeglePluginToken: string;
	meegleUserKey: string;
	/** 可选：缺失时禁用通知（日志 WARN），不 fail-fast */
	larkWebhook: string | null;
}

export interface VulcanConfig {
	gateway: GatewayConfig;
	meegle: MeegleConfig;
	db: DbConfig;
	agent: AgentConfig;
	session: SessionConfig;
	retry: RetryConfig;
	secrets: Secrets;
}

export class ConfigError extends Error {}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.length === 0) {
		throw new ConfigError(`缺少必填环境变量 ${name}`);
	}
	return v;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConfigError(`配置项 ${label} 必须是数字`);
	}
	return value;
}

function requirePort(value: unknown, label: string): number {
	const n = requireNumber(value, label);
	// port 0 = 随机端口（合法）；其余必须是 1-65535
	if (!Number.isInteger(n) || n < 0 || n > 65535) {
		throw new ConfigError(`配置项 ${label} 必须是 0-65535 的整数（0 = 随机端口）`);
	}
	return n;
}

function requirePositiveInt(value: unknown, label: string): number {
	const n = requireNumber(value, label);
	if (!Number.isInteger(n) || n <= 0) {
		throw new ConfigError(`配置项 ${label} 必须是正整数`);
	}
	return n;
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function assertDbPathWritable(dbPath: string): void {
	if (dbPath === ":memory:") return;
	const dir = dirname(dbPath);
	try {
		accessSync(dir, constants.W_OK);
	} catch {
		// 目录不存在则尝试创建；创建失败按不可写处理
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			throw new ConfigError(`db.path 目录不可写：${dir}`);
		}
	}
}

/** 解析并校验配置（fail-fast：任一必填缺失或非法即抛 ConfigError） */
export function loadConfig(rawYaml: unknown): VulcanConfig {
	const raw = (rawYaml ?? {}) as Record<string, Record<string, unknown>>;

	const gatewayRaw = raw.gateway ?? {};
	const host = typeof gatewayRaw.host === "string" ? gatewayRaw.host : "127.0.0.1";
	if (!isLoopback(host)) {
		throw new ConfigError(`gateway.host 必须为 loopback（127.0.0.1 / ::1 / localhost），实际：${host}`);
	}
	const port = requirePort(gatewayRaw.port ?? 7620, "gateway.port");
	const maxBodyBytes = requirePositiveInt(gatewayRaw.maxBodyBytes, "gateway.maxBodyBytes");

	const meegleRaw = raw.meegle ?? {};
	if (typeof meegleRaw.baseUrl !== "string" || meegleRaw.baseUrl.length === 0) {
		throw new ConfigError("meegle.baseUrl 必填");
	}

	const dbRaw = raw.db ?? {};
	const dbPath = typeof dbRaw.path === "string" && dbRaw.path.length > 0 ? dbRaw.path : "data/vulcan.db";
	assertDbPathWritable(dbPath);

	const agentRaw = raw.agent ?? {};
	const agent = {
		maxSteps: requirePositiveInt(agentRaw.maxSteps ?? 50, "agent.maxSteps"),
		tokenBudget: requireNumber(agentRaw.tokenBudget ?? 160000, "agent.tokenBudget"),
		costUsdBudget: requireNumber(agentRaw.costUsdBudget ?? 5, "agent.costUsdBudget"),
	};

	const sessionRaw = raw.session ?? {};
	const summaryAtBudgetPct = requireNumber(sessionRaw.summaryAtBudgetPct ?? 60, "session.summaryAtBudgetPct");
	if (summaryAtBudgetPct <= 0 || summaryAtBudgetPct > 100) {
		throw new ConfigError("session.summaryAtBudgetPct 必须在 (0, 100] 区间");
	}
	const session = {
		summaryEverySteps: requirePositiveInt(sessionRaw.summaryEverySteps ?? 15, "session.summaryEverySteps"),
		summaryAtBudgetPct,
	};

	const retryRaw = raw.retry ?? {};
	const retry = { maxAttempts: requirePositiveInt(retryRaw.maxAttempts ?? 3, "retry.maxAttempts") };

	const secrets: Secrets = {
		webhookSecretAlert: requireEnv("VULCAN_WEBHOOK_SECRET_ALERT"),
		webhookSecretMeegle: requireEnv("VULCAN_WEBHOOK_SECRET_MEEGLE"),
		webhookSecretApproval: requireEnv("VULCAN_WEBHOOK_SECRET_APPROVAL"),
		meeglePluginToken: requireEnv("VULCAN_MEEGLE_PLUGIN_TOKEN"),
		meegleUserKey: requireEnv("VULCAN_MEEGLE_USER_KEY"),
		larkWebhook: process.env.VULCAN_LARK_WEBHOOK || null,
	};

	return {
		gateway: { host, port, maxBodyBytes },
		meegle: { baseUrl: meegleRaw.baseUrl as string },
		db: { path: dbPath },
		agent,
		session,
		retry,
		secrets,
	};
}
