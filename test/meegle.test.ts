import { describe, expect, it } from "vitest";
import { MeegleClient, MeegleApiError } from "../src/server/meegle/index.ts";

const SECRETS = { meeglePluginToken: "pt", meegleUserKey: "uk" };
const CONFIG = { baseUrl: "https://meegle.test" };

/** 可编程 mock fetch：按调用序号返回响应并记录请求 */
function mockFetch(script: Array<{ status: number; body?: unknown } | { throw: Error }>, log: Array<{ url: string; init: RequestInit }>) {
	let i = 0;
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const step = script[Math.min(i, script.length - 1)];
		i++;
		log.push({ url: String(url), init: init ?? {} });
		if ("throw" in step) throw step.throw;
		return new Response(JSON.stringify(step.body ?? {}), { status: step.status });
	}) as typeof fetch;
}

function makeClient(script: Parameters<typeof mockFetch>[0], log: Array<{ url: string; init: RequestInit }>, opts = {}) {
	return new MeegleClient(CONFIG, SECRETS, {
		fetchImpl: mockFetch(script, log),
		delay: () => Promise.resolve(),
		now: () => 1_000_000,
		retryBaseMs: 1,
		...opts,
	});
}

describe("P2-3 meegle client 鉴权与幂等", () => {
	it("请求携带 X-PLUGIN-TOKEN / X-USER-KEY 鉴权头", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 200, body: { ok: 1 } }], log);
		await c.getWorkItem("pj", "42");
		const headers = log[0].init.headers as Record<string, string>;
		expect(headers["x-plugin-token"]).toBe("pt");
		expect(headers["x-user-key"]).toBe("uk");
	});

	it("写接口必须携带 X-IDEM-UUID：显式传入则复用，缺省自动生成", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 200, body: {} }, { status: 200, body: {} }], log);
		await c.updateStatus("pj", "42", "done", "fixed-uuid");
		await c.addComment("pj", "42", "hello");
		const h1 = log[0].init.headers as Record<string, string>;
		const h2 = log[1].init.headers as Record<string, string>;
		expect(h1["x-idem-uuid"]).toBe("fixed-uuid");
		expect(h2["x-idem-uuid"]).toMatch(/[0-9a-f-]{36}/);
		expect(h2["x-idem-uuid"]).not.toBe(h1["x-idem-uuid"]);
	});

	it("同幂等 UUID 重试时保持不变（重试不换键）", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 500 }, { status: 200, body: {} }], log);
		await c.updateStatus("pj", "42", "done", "same-uuid");
		const u1 = (log[0].init.headers as Record<string, string>)["x-idem-uuid"];
		const u2 = (log[1].init.headers as Record<string, string>)["x-idem-uuid"];
		expect(u1).toBe(u2);
		expect(u1).toBe("same-uuid");
	});
});

describe("P2-3 限流与重试", () => {
	it("429 触发退避重试，最终成功", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 429 }, { status: 200, body: { ok: 1 } }], log);
		const res = await c.updateStatus("pj", "42", "done");
		expect(res).toEqual({ ok: 1 });
		expect(log.length).toBe(2);
	});

	it("429 三次耗尽 → 抛 MeegleApiError(429)", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 429 }], log, { maxAttempts: 3 });
		await expect(c.updateStatus("pj", "42", "done")).rejects.toThrow(MeegleApiError);
		expect(log.length).toBe(3);
	});

	it("业务 4xx（非 429）不重试直接抛", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 403, body: { msg: "forbidden" } }], log, { maxAttempts: 3 });
		await expect(c.getWorkItem("pj", "1")).rejects.toThrow(/403/);
		expect(log.length).toBe(1);
	});

	it("15 QPS：同一 method 1 秒窗口内第 16 次请求被延迟（限流内不丢请求）", async () => {
		let nowMs = 1_000_000;
		const delays: number[] = [];
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = new MeegleClient(CONFIG, SECRETS, {
			fetchImpl: mockFetch([{ status: 200, body: {} }], log),
			delay: (ms) => {
				delays.push(ms);
				nowMs += ms; // 时间随等待推进
				return Promise.resolve();
			},
			now: () => nowMs,
			retryBaseMs: 1,
		});
		// 发 17 个请求：前 15 个即时，第 16+ 个应产生等待
		const jobs = Array.from({ length: 17 }, () => c.getWorkItem("pj", "1"));
		await Promise.all(jobs);
		expect(log.length).toBe(17); // 不丢请求
		expect(delays.length).toBeGreaterThan(0); // 有节流等待
	});
});

describe("P2-3 业务方法路径", () => {
	it("listWorkItemsByWindow / linkPr / getComments 请求路径与参数正确", async () => {
		const log: Array<{ url: string; init: RequestInit }> = [];
		const c = makeClient([{ status: 200, body: {} }, { status: 200, body: {} }, { status: 200, body: {} }], log);
		await c.listWorkItemsByWindow("pj", 100, 200);
		await c.linkPr("pj", "42", "https://git/pr/1", "u-1");
		await c.getComments("pj", "42");
		expect(log[0].url).toContain("/open_api/work_item/filter?project_key=pj&updated_from=100&updated_to=200");
		expect(log[1].url).toContain("/open_api/work_item/link/create");
		expect((log[1].init.headers as Record<string, string>)["x-idem-uuid"]).toBe("u-1");
		expect(log[2].url).toContain("/open_api/work_item/comment/query");
	});
});
