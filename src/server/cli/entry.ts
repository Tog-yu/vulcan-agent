/**
 * 入口：装配网关 + Harness，启动 HTTP 监听。
 * 配置：config/config.yaml（可选）+ 环境变量（密钥只走 env）。
 */

import { loadConfig } from "../config/index.ts";
import { EventQueue } from "../gateway/queue.ts";
import { GatewayServer } from "../gateway/server.ts";
import { Harness } from "../harness/index.ts";

const config = loadConfig();

const secretOf = (source: string) => {
	const key = config.gateway.sources[source]?.envKey;
	return key ? process.env[key] : undefined;
};

const queue = new EventQueue();
const gateway = new GatewayServer({ config, secretOf, queue });
const harness = new Harness({ queue });

await gateway.listen();
harness.start();

const shutdown = async () => {
	console.log("\n[cli] shutting down...");
	harness.stop();
	await gateway.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[cli] vulcan-agent ready.
  webhook:  POST http://${config.gateway.host}:${config.gateway.port}/webhook/{alert|meegle|approval}
  health:   GET  http://${config.gateway.host}:${config.gateway.port}/healthz
  secrets:  VULCAN_WEBHOOK_SECRET_{ALERT|MEEGLE|APPROVAL} env vars`);
