import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/server/config/index.ts";

const VALID_ENV = {
	VULCAN_WEBHOOK_SECRET_ALERT: "sk-alert",
	VULCAN_WEBHOOK_SECRET_MEEGLE: "sk-meegle",
	VULCAN_WEBHOOK_SECRET_APPROVAL: "sk-approval",
	VULCAN_MEEGLE_PLUGIN_TOKEN: "plugin-token",
	VULCAN_MEEGLE_USER_KEY: "user-key",
};

const VALID_YAML = {
	gateway: { host: "127.0.0.1", port: 7620, maxBodyBytes: 1048576 },
	meegle: { baseUrl: "https://meegle.com" },
	db: { path: ":memory:" },
};

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved = { ...process.env };
	try {
		// 清掉相关变量，保证测试隔离
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("VULCAN_")) delete process.env[k];
		}
		for (const [k, v] of Object.entries(env)) {
			if (v !== undefined) process.env[k] = v;
		}
		fn();
	} finally {
		process.env = saved;
	}
}

describe("loadConfig", () => {
	beforeEach(() => {
		withEnv(VALID_ENV, () => {});
	});

	it("正常配置解析成功，密钥来自环境变量", () => {
		withEnv(VALID_ENV, () => {
			const cfg = loadConfig(VALID_YAML);
			expect(cfg.gateway).toEqual({ host: "127.0.0.1", port: 7620, maxBodyBytes: 1048576 });
			expect(cfg.secrets.webhookSecretAlert).toBe("sk-alert");
			expect(cfg.agent.maxSteps).toBe(50);
			expect(cfg.session.summaryEverySteps).toBe(15);
			expect(cfg.retry.maxAttempts).toBe(3);
		});
	});

	it("VULCAN_LARK_WEBHOOK 缺失时为 null，不 fail-fast", () => {
		withEnv(VALID_ENV, () => {
			const cfg = loadConfig(VALID_YAML);
			expect(cfg.secrets.larkWebhook).toBeNull();
		});
	});

	it("缺少必填密钥 → ConfigError", () => {
		withEnv({ VULCAN_WEBHOOK_SECRET_ALERT: "sk-alert" }, () => {
			expect(() => loadConfig(VALID_YAML)).toThrow(ConfigError);
			expect(() => loadConfig(VALID_YAML)).toThrow(/VULCAN_WEBHOOK_SECRET_MEEGLE/);
		});
	});

	it("gateway.host 非 loopback → ConfigError", () => {
		withEnv(VALID_ENV, () => {
			const bad = { ...VALID_YAML, gateway: { ...VALID_YAML.gateway, host: "0.0.0.0" } };
			expect(() => loadConfig(bad)).toThrow(/loopback/);
		});
	});

	it("port 0 = 随机端口，合法放行", () => {
		withEnv(VALID_ENV, () => {
			const cfg = loadConfig({ ...VALID_YAML, gateway: { ...VALID_YAML.gateway, port: 0 } });
			expect(cfg.gateway.port).toBe(0);
		});
	});

	it("port 超范围（65536）→ ConfigError", () => {
		withEnv(VALID_ENV, () => {
			const bad = { ...VALID_YAML, gateway: { ...VALID_YAML.gateway, port: 65536 } };
			expect(() => loadConfig(bad)).toThrow(/gateway\.port/);
		});
	});

	it("port 非正整数 → ConfigError", () => {
		withEnv(VALID_ENV, () => {
			const bad = { ...VALID_YAML, gateway: { ...VALID_YAML.gateway, port: -1 } };
			expect(() => loadConfig(bad)).toThrow(/gateway\.port/);
		});
	});

	it("meegle.baseUrl 缺失 → ConfigError", () => {
		withEnv(VALID_ENV, () => {
			expect(() => loadConfig({ gateway: VALID_YAML.gateway, meegle: {} })).toThrow(/baseUrl/);
		});
	});

	it("db.path 目录不可写 → ConfigError", () => {
		withEnv(VALID_ENV, () => {
			expect(() => loadConfig({ ...VALID_YAML, db: { path: "/proc/1/forbidden/vulcan.db" } })).toThrow(ConfigError);
		});
	});

	it("db.path 目录不存在时可自动创建", () => {
		const tmp = mkdtempSync(join(tmpdir(), "vulcan-test-"));
		const dbPath = join(tmp, "nested", "deeper", "vulcan.db");
		withEnv(VALID_ENV, () => {
			const cfg = loadConfig({ ...VALID_YAML, db: { path: dbPath } });
			expect(cfg.db.path).toBe(dbPath);
		});
	});

	it("session.summaryAtBudgetPct 超范围 → ConfigError", () => {
		withEnv(VALID_ENV, () => {
			const bad = { ...VALID_YAML, session: { summaryEverySteps: 15, summaryAtBudgetPct: 101 } };
			expect(() => loadConfig(bad)).toThrow(/summaryAtBudgetPct/);
		});
	});
});
