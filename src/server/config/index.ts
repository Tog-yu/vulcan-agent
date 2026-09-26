/**
 * 配置加载 —— YAML + 环境变量覆盖。
 * 密钥（webhook 签名密钥、meegle token、飞书凭证）只从环境变量读，不落 config 文件。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface GatewayConfig {
	host: string;
	port: number;
	/** 各来源的鉴权方式与密钥（密钥值从 env 注入） */
	sources: Record<string, { auth: "hmac" | "bearer"; envKey: string }>;
	/** 请求体大小上限 */
	maxBodyBytes: number;
}

export interface AppConfig {
	gateway: GatewayConfig;
	meegle: {
		baseUrl: string;
		/** Open API 凭据，从 env 注入 */
		pluginTokenEnv: string;
		userKeyEnv: string;
	};
	notify: {
		larkWebhookEnv: string;
	};
}

const DEFAULTS: AppConfig = {
	gateway: {
		host: "127.0.0.1", // 硬约束：仅 loopback，暴露须经 reverse proxy
		port: 7620,
		sources: {
			alert: { auth: "hmac", envKey: "VULCAN_WEBHOOK_SECRET_ALERT" },
			meegle: { auth: "hmac", envKey: "VULCAN_WEBHOOK_SECRET_MEEGLE" },
			approval: { auth: "hmac", envKey: "VULCAN_WEBHOOK_SECRET_APPROVAL" },
		},
		maxBodyBytes: 1 << 20,
	},
	meegle: {
		baseUrl: "https://meegle.com",
		pluginTokenEnv: "VULCAN_MEEGLE_PLUGIN_TOKEN",
		userKeyEnv: "VULCAN_MEEGLE_USER_KEY",
	},
	notify: {
		larkWebhookEnv: "VULCAN_LARK_WEBHOOK",
	},
};

export function loadConfig(configPath?: string): AppConfig {
	if (!configPath) return DEFAULTS;
	const raw = parse(readFileSync(configPath, "utf-8")) as Partial<AppConfig>;
	return {
		gateway: { ...DEFAULTS.gateway, ...raw.gateway },
		meegle: { ...DEFAULTS.meegle, ...raw.meegle },
		notify: { ...DEFAULTS.notify, ...raw.notify },
	};
}
