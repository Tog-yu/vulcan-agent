/**
 * meegle Open API client（DEV_SPEC §14 P2-3，技术方案 7.2）。
 *
 * 口径（官方文档）：RESTful，X-PLUGIN-TOKEN / X-USER-KEY 鉴权，
 * X-IDEM-UUID 幂等（写接口），单 token 单接口 15 QPS 限流。
 *
 * 限流：按方法名维度做令牌桶（15 QPS），超限等待而非丢弃（限流内不丢请求）。
 * 重试：429/5xx/网络错误按指数退避重试，最多 retry.maxAttempts 次。
 * 幂等：写接口必须携带调用方传入或自动生成的 X-IDEM-UUID。
 */

import { randomUUID } from "node:crypto";
import type { MeegleConfig, Secrets } from "../config/index.ts";

export interface MeegleClientOptions {
	/** 单接口 QPS 上限（官方 15），默认 15 */
	qps?: number;
	/** 重试次数（含首次），默认 3 */
	maxAttempts?: number;
	/** 退避基数 ms，默认 200 */
	retryBaseMs?: number;
	/** 测试注入：替代全局 fetch */
	fetchImpl?: typeof fetch;
	/** 测试注入：替代 setTimeout */
	delay?: (ms: number) => Promise<void>;
	now?: () => number;
}

export class MeegleApiError extends Error {
	readonly status: number;
	readonly method: string;

	constructor(status: number, method: string, message: string) {
		super(`meegle ${method} 失败（HTTP ${status}）：${message}`);
		this.status = status;
		this.method = method;
	}
}

export class MeegleClient {
	private readonly config: MeegleConfig;
	private readonly secrets: Pick<Secrets, "meeglePluginToken" | "meegleUserKey">;
	private readonly qps: number;
	private readonly maxAttempts: number;
	private readonly retryBaseMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly now: () => number;
	/** method → 上次请求时间戳队列（滑动窗口限流） */
	private readonly windows = new Map<string, number[]>();

	constructor(
		config: MeegleConfig,
		secrets: Pick<Secrets, "meeglePluginToken" | "meegleUserKey">,
		options: MeegleClientOptions = {},
	) {
		this.config = config;
		this.secrets = secrets;
		this.qps = options.qps ?? 15;
		this.maxAttempts = options.maxAttempts ?? 3;
		this.retryBaseMs = options.retryBaseMs ?? 200;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.delay = options.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
		this.now = options.now ?? Date.now;
	}

	/** 滑动窗口限流：1s 内该 method 已发 >= qps 则等待到窗口滑出 */
	private async throttle(method: string): Promise<void> {
		const list = this.windows.get(method) ?? [];
		const cutoff = this.now() - 1000;
		while (list.length > 0 && list[0] <= cutoff) list.shift();
		if (list.length >= this.qps) {
			const waitMs = list[0] + 1000 - this.now() + 1;
			await this.delay(Math.max(waitMs, 1));
		}
		list.push(this.now());
		this.windows.set(method, list);
	}

	private authHeaders(): Record<string, string> {
		return {
			"x-plugin-token": this.secrets.meeglePluginToken,
			"x-user-key": this.secrets.meegleUserKey,
			"content-type": "application/json",
		};
	}

	/** 写请求：必须带 X-IDEM-UUID（调用方可传幂等键，缺省自动生成） */
	private async write(method: string, path: string, body: unknown, idemUuid?: string): Promise<Record<string, unknown>> {
		const uuid = idemUuid ?? randomUUID();
		let lastErr: Error | null = null;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			await this.throttle(method);
			try {
				const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
					method: "POST",
					headers: { ...this.authHeaders(), "x-idem-uuid": uuid },
					body: JSON.stringify(body ?? {}),
				});
				if (res.ok) return (await res.json()) as Record<string, unknown>;
				if (res.status === 429 || res.status >= 500) {
					lastErr = new MeegleApiError(res.status, method, res.statusText);
					if (attempt < this.maxAttempts) {
						await this.delay(this.retryBaseMs * 2 ** (attempt - 1));
						continue;
					}
					throw lastErr;
				}
				// 4xx 其他：业务错误，不重试
				throw new MeegleApiError(res.status, method, await res.text());
			} catch (err) {
				if (err instanceof MeegleApiError && err.status < 500 && err.status !== 429) throw err;
				lastErr = err as Error;
				if (attempt >= this.maxAttempts) throw lastErr;
				await this.delay(this.retryBaseMs * 2 ** (attempt - 1));
			}
		}
		throw lastErr ?? new MeegleApiError(0, method, "unreachable");
	}

	/** 读请求：GET 语义，重试只针对 429/5xx/网络错误 */
	private async read(method: string, path: string): Promise<Record<string, unknown>> {
		let lastErr: Error | null = null;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			await this.throttle(method);
			try {
				const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
					method: "GET",
					headers: this.authHeaders(),
				});
				if (res.ok) return (await res.json()) as Record<string, unknown>;
				if (res.status === 429 || res.status >= 500) {
					lastErr = new MeegleApiError(res.status, method, res.statusText);
					if (attempt < this.maxAttempts) {
						await this.delay(this.retryBaseMs * 2 ** (attempt - 1));
						continue;
					}
				}
				throw new MeegleApiError(res.status, method, await res.text());
			} catch (err) {
				if (err instanceof MeegleApiError && err.status < 500 && err.status !== 429) throw err;
				lastErr = err as Error;
				if (attempt >= this.maxAttempts) throw lastErr;
				await this.delay(this.retryBaseMs * 2 ** (attempt - 1));
			}
		}
		throw lastErr ?? new MeegleApiError(0, method, "unreachable");
	}

	// ---- 业务方法 ----

	/** 工单详情回查（Webhook 只带概要，详情按需回查） */
	getWorkItem(projectKey: string, workItemId: string | number): Promise<Record<string, unknown>> {
		return this.read("getWorkItem", `/open_api/work_item/detail?project_key=${encodeURIComponent(projectKey)}&work_item_id=${encodeURIComponent(String(workItemId))}`);
	}

	/** 工单评论列表 */
	getComments(projectKey: string, workItemId: string | number): Promise<Record<string, unknown>> {
		return this.read("getComments", `/open_api/work_item/comment/query?project_key=${encodeURIComponent(projectKey)}&work_item_id=${encodeURIComponent(String(workItemId))}`);
	}

	/** 状态回写（幂等：idemUuid 建议用 task 级派生键，重复调用安全） */
	updateStatus(projectKey: string, workItemId: string | number, status: string, idemUuid?: string): Promise<Record<string, unknown>> {
		return this.write("updateStatus", "/open_api/work_item/status/update", { project_key: projectKey, work_item_id: workItemId, status }, idemUuid);
	}

	/** 补备注 */
	addComment(projectKey: string, workItemId: string | number, comment: string, idemUuid?: string): Promise<Record<string, unknown>> {
		return this.write("addComment", "/open_api/work_item/comment/create", { project_key: projectKey, work_item_id: workItemId, comment }, idemUuid);
	}

	/** 关联 PR（挂 commit/PR 引用） */
	linkPr(projectKey: string, workItemId: string | number, prUrl: string, idemUuid?: string): Promise<Record<string, unknown>> {
		return this.write("linkPr", "/open_api/work_item/link/create", { project_key: projectKey, work_item_id: workItemId, link_type: "pr", url: prUrl }, idemUuid);
	}

	/** 对账兜底：按更新时间窗拉取工单列表（webhook 丢事件补偿） */
	listWorkItemsByWindow(projectKey: string, updatedFrom: number, updatedTo: number): Promise<Record<string, unknown>> {
		return this.read("listWorkItemsByWindow", `/open_api/work_item/filter?project_key=${encodeURIComponent(projectKey)}&updated_from=${updatedFrom}&updated_to=${updatedTo}`);
	}
}
