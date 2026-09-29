/**
 * HTTP 网关（DEV_SPEC §14 P1-3/P1-4/P1-5）。
 *
 * 职责边界（HTTP 层零业务逻辑）：
 *   - 统一入口 /webhook/:source（alert | meegle | approval）
 *   - 读体限长（超 maxBodyBytes → 413）→ HMAC 签名校验（401/403）→ JSON 解析
 *   - 归一化 InternalEvent → 幂等入库（重复返回 2xx）→ 交给 sink（异步处理）
 *   - 仅 loopback bind（DEV_SPEC §9 fail-fast）
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { VulcanConfig } from "../config/index.ts";
import type { InternalEvent, EventSource } from "../types.ts";
import { verifyWebhook, type SecretProvider, type WebhookSource } from "./verify.ts";
import { normalizeEvent } from "./normalize.ts";
import { PayloadTooLargeError } from "./errors.ts";

export interface EventSink {
	/** 返回 true 表示该事件 ID 首次入库；false 表示重复（幂等命中） */
	tryEnqueue(event: InternalEvent): Promise<boolean>;
}

export interface GatewayDeps {
	config: VulcanConfig;
	secrets: SecretProvider;
	sink: EventSink;
	onLog?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

const SOURCES: ReadonlySet<string> = new Set(["alert", "meegle", "approval"]);

function readBody(req: IncomingMessage, maxBytes: number, res: ServerResponse): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			if (tooLarge) return;
			total += chunk.length;
			if (total > maxBytes) {
				tooLarge = true;
				// 先发 413 再断连接，避免客户端拿到 ECONNRESET 而非响应
				sendJson(res, 413, { error: "payload too large" });
				req.destroy();
				reject(new PayloadTooLargeError(`body 超过 ${maxBytes} 字节`));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!tooLarge) resolve(Buffer.concat(chunks));
		});
		req.on("error", () => {
			/* 413 已响应；其余错误由 end 未触发自然放弃 */
		});
	});
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

export function createGateway(deps: GatewayDeps): Server {
	const { config, secrets, sink, onLog } = deps;

	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (req.method !== "POST" || !url.pathname.startsWith("/webhook/")) {
			sendJson(res, 404, { error: "not found" });
			return;
		}
		const source = url.pathname.slice("/webhook/".length) as WebhookSource;
		if (!SOURCES.has(source)) {
			sendJson(res, 404, { error: `未知 source：${source}` });
			return;
		}

		let rawBody: Buffer;
		try {
			rawBody = await readBody(req, config.gateway.maxBodyBytes, res);
		} catch {
			// 413 响应已在 readBody 内发出；其余读取错误按 400 兜底（若响应头未写）
			if (!res.writableEnded) {
				onLog?.("error", "读体失败", { source, status: 400 });
				sendJson(res, 400, { error: "bad request" });
			}
			return;
		}

		// HMAC 签名校验（密钥按 source 隔离）；query string 传 token 一律拒绝
		const verdict = verifyWebhook(source, rawBody, req.headers, url, secrets);
		if (!verdict.ok) {
			onLog?.("warn", "webhook 鉴权失败", { source, status: verdict.status, reason: verdict.reason });
			sendJson(res, verdict.status, { error: verdict.reason });
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("payload 必须是 JSON 对象");
			}
			payload = parsed as Record<string, unknown>;
		} catch (err) {
			sendJson(res, 400, { error: `JSON 解析失败：${(err as Error).message}` });
			return;
		}

		let event: InternalEvent;
		try {
			event = normalizeEvent(source as EventSource, payload);
		} catch (err) {
			onLog?.("warn", "payload 归一化失败", { source, error: (err as Error).message });
			sendJson(res, 422, { error: (err as Error).message });
			return;
		}

		// 幂等入库：重复事件直接 2xx（DEV_SPEC §7 接口契约）
		let first: boolean;
		try {
			first = await sink.tryEnqueue(event);
		} catch (err) {
			onLog?.("error", "事件入库失败", { source, eventId: event.id, error: (err as Error).message });
			sendJson(res, 500, { error: "internal error" });
			return;
		}
		if (!first) {
			onLog?.("info", "重复事件，幂等跳过", { source, eventId: event.id });
			sendJson(res, 200, { received: true, dedup: true });
			return;
		}

		sendJson(res, 200, { received: true });
	});
}

/** 仅 loopback bind（DEV_SPEC §9 fail-fast：非 loopback 拒绝启动） */
export function startGateway(deps: GatewayDeps): Promise<Server> {
	const { host, port } = deps.config.gateway;
	if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
		return Promise.reject(new Error(`拒绝启动：gateway.host 必须为 loopback，实际 ${host}`));
	}
	return new Promise((resolve, reject) => {
		const server = createGateway(deps);
		server.once("error", reject);
		server.listen(port, host, () => resolve(server));
	});
}
