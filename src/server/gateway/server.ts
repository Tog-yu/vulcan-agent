/**
 * Webhook 统一接入层（技术方案 · 七）
 *
 * 职责：HTTP 层零业务逻辑 —— 鉴权 + 读体 + 归一化 → 交给 Harness。
 *   - 统一入口 /webhook/:source（alert | meegle | approval）
 *   - 签名校验（HMAC-SHA256，密钥按 source 隔离；另支持 Bearer token 恒定时间比对）
 *   - 幂等：以事件唯一 ID 去重，重复投递直接 200
 *   - 快速 2xx，耗时任务转异步队列；失败重试，超阈值进死信
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AppConfig } from "../config/index.ts";
import type { EventSource, InternalEvent } from "../types.ts";
import { normalizeAlert, normalizeApproval, normalizeMeegle } from "./normalize.ts";
import type { EventQueue } from "./queue.ts";

// ---------- 鉴权 ----------

export function hmacSign(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

export function hmacVerify(secret: string, body: string, signature: string | undefined): boolean {
	if (!signature) return false;
	const expected = hmacSign(secret, body);
	const a = Buffer.from(expected, "utf-8");
	const b = Buffer.from(signature.trim().replace(/^sha256=/, ""), "utf-8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function bearerMatches(expected: string | undefined, provided: string | undefined): boolean {
	if (!expected || !provided) return false;
	const a = Buffer.from(expected, "utf-8");
	const b = Buffer.from(provided, "utf-8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// ---------- 归一化路由 ----------

const NORMALIZERS: Record<EventSource, (body: unknown) => InternalEvent> = {
	alert: normalizeAlert,
	meegle: normalizeMeegle,
	approval: normalizeApproval,
};

// ---------- 服务 ----------

/** 兼容取头：真实 IncomingMessage 是 plain object，web Request 是 Headers 实例（测试注入用） */
function headerOf(req: IncomingMessage, name: string): string | undefined {
	const headers = req.headers as unknown;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	return (headers as Record<string, string | string[] | undefined>)[name] as string | undefined;
}

export interface GatewayDeps {
	config: AppConfig;
	secretOf: (source: EventSource) => string | undefined;
	queue: EventQueue;
}

export class GatewayServer {
	readonly #deps: GatewayDeps;
	#server?: Server;

	constructor(deps: GatewayDeps) {
		this.#deps = deps;
	}

	/** 处理单个请求（可注入测试，不必起真实端口） */
	async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				return this.#reply(res, 200, { status: "ok", uptime: process.uptime() });
			}

			const match = /^\/webhook\/(alert|meegle|approval)$/.exec(url.pathname);
			if (!match || req.method !== "POST") {
				return this.#reply(res, 404, { error: "not found" });
			}
			const source = match[1] as EventSource;

			// 鉴权
			const secret = this.#deps.secretOf(source);
			const bearer = /^Bearer\s+(.+)$/i.exec(headerOf(req, "authorization") ?? "")?.[1];
			let body = "";
			try {
				body = await this.#readBody(req);
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode ?? 400;
				return this.#reply(res, status, { error: status === 413 ? "payload too large" : "read body failed" });
			}
			const sig = headerOf(req, "x-vulcan-signature");
			const ok = (secret && hmacVerify(secret, body, sig)) || (secret && bearerMatches(secret, bearer));
			if (!ok) {
				return this.#reply(res, 401, { error: "unauthorized" });
			}

			// 归一化 + 幂等 + 入队
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				return this.#reply(res, 400, { error: "invalid json" });
			}
			const event = NORMALIZERS[source](parsed);
			const enqueued = this.#deps.queue.enqueue(event);
			if (!enqueued) {
				// 重复投递：直接确认，避免触发端反复重试
				return this.#reply(res, 200, { status: "duplicate", eventId: event.id });
			}
			return this.#reply(res, 200, { status: "accepted", eventId: event.id });
		} catch (err) {
			// 单请求异常不影响主监听
			console.error("[gateway] request error:", err);
			return this.#reply(res, 500, { error: "internal" });
		}
	}

	#readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			// 兼容两类入参：真实 IncomingMessage（事件流）与 web Request（其 body 为 ReadableStream，测试注入用）
			const stream =
				typeof (req as unknown as { on?: unknown }).on === "function"
					? req
					: (Readable.fromWeb(
							(req as unknown as { body: import("node:stream/web").ReadableStream }).body,
						) as unknown as IncomingMessage);
			const chunks: Buffer[] = [];
			let size = 0;
			stream.on("data", (c: Buffer) => {
				size += c.length;
				if (size > this.#deps.config.gateway.maxBodyBytes) {
					reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
					stream.destroy();
					return;
				}
				chunks.push(c);
			});
			stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			stream.on("error", reject);
		});
	}

	#reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}

	listen(): Promise<void> {
		const { host, port } = this.#deps.config.gateway;
		const server = createServer((req, res) => void this.handleRequest(req, res));
		this.#server = server;
		return new Promise((resolve) => {
			server.listen(port, host, () => {
				console.log(`[gateway] listening on http://${host}:${port} (loopback only)`);
				resolve();
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => this.#server?.close(() => resolve()));
	}
}
