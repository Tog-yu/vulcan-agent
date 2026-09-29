import { describe, expect, it, afterEach } from "vitest";
import { createGateway, startGateway, type GatewayDeps, type EventSink } from "../src/server/gateway/index.ts";
import { signPayload } from "../src/server/gateway/verify.ts";
import type { InternalEvent } from "../src/server/types.ts";
import type { VulcanConfig } from "../src/server/config/index.ts";
import type { Server } from "node:http";

function makeConfig(overrides: Partial<VulcanConfig["gateway"]> = {}): VulcanConfig {
	return {
		gateway: { host: "127.0.0.1", port: 0, maxBodyBytes: 1024, ...overrides },
		meegle: { baseUrl: "https://meegle.com" },
		db: { path: ":memory:" },
		agent: { maxSteps: 50, tokenBudget: 160000, costUsdBudget: 5 },
		session: { summaryEverySteps: 15, summaryAtBudgetPct: 60 },
		retry: { maxAttempts: 3 },
		secrets: {
			webhookSecretAlert: "sk-alert",
			webhookSecretMeegle: "sk-meegle",
			webhookSecretApproval: "sk-approval",
			meeglePluginToken: "pt",
			meegleUserKey: "uk",
			larkWebhook: null,
		},
	};
}

function makeSink(seen: InternalEvent[] = []): EventSink & { seenIds: () => string[] } {
	const ids = new Set<string>();
	return {
		async tryEnqueue(event: InternalEvent) {
			if (ids.has(event.id)) return false;
			ids.add(event.id);
			seen.push(event);
			return true;
		},
		seenIds: () => [...ids],
	};
}

function makeDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps & { sink: ReturnType<typeof makeSink> } {
	const sink = makeSink();
	return {
		config: makeConfig(),
		secrets: {
			getSecret: (s) =>
				({ alert: "sk-alert", meegle: "sk-meegle", approval: "sk-approval" })[s],
		},
		sink,
		...overrides,
	} as GatewayDeps & { sink: ReturnType<typeof makeSink> };
}

async function post(server: Server, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, {
		method: "POST",
		body,
		headers,
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function signedHeaders(source: "alert" | "meegle" | "approval", body: string): Record<string, string> {
	const secret = { alert: "sk-alert", meegle: "sk-meegle", approval: "sk-approval" }[source];
	return { "x-vulcan-signature": signPayload(source, Buffer.from(body, "utf8"), secret), "content-type": "application/json" };
}

let server: Server | null = null;
let deps: ReturnType<typeof makeDeps> | null = null;

async function start(depsOverride: Partial<GatewayDeps> = {}): Promise<ReturnType<typeof makeDeps>> {
	deps = makeDeps(depsOverride);
	server = createGateway(deps);
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	return deps;
}

afterEach(() => {
	server?.close();
	server = null;
	deps = null;
});

describe("gateway HTTP", () => {
	it("非 /webhook/ 路径或非 POST → 404", async () => {
		await start();
		expect((await post(server!, "/other", "{}", signedHeaders("alert", "{}"))).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/webhook/alert`)).status).toBe(404);
	});

	it("未知 source → 404", async () => {
		await start();
		expect((await post(server!, "/webhook/github", "{}", signedHeaders("alert", "{}"))).status).toBe(404);
	});

	it("缺签名头 → 401；错误签名 → 403", async () => {
		await start();
		const body = JSON.stringify({ fingerprint: "f1" });
		expect((await post(server!, "/webhook/alert", body, {})).status).toBe(401);
		expect((await post(server!, "/webhook/alert", body, { "x-vulcan-signature": "deadbeef" })).status).toBe(403);
	});

	it("query string 传 token → 403（PLAN-TRACKING 硬约束 2）", async () => {
		await start();
		const body = JSON.stringify({ fingerprint: "f1" });
		const res = await post(server!, "/webhook/alert?token=abc", body, signedHeaders("alert", body));
		expect(res.status).toBe(403);
	});

	it("超 maxBodyBytes → 413", async () => {
		await start({ config: makeConfig({ maxBodyBytes: 16 }) });
		const big = JSON.stringify({ fingerprint: "x".repeat(64) });
		const res = await post(server!, "/webhook/alert", big, signedHeaders("alert", big));
		expect(res.status).toBe(413);
	});

	it("非法 JSON → 400", async () => {
		await start();
		const bad = "{not json";
		expect((await post(server!, "/webhook/alert", bad, signedHeaders("alert", bad))).status).toBe(400);
	});

	it("startGateway 非 loopback host 拒绝启动（DEV_SPEC §9 fail-fast）", async () => {
		const d = makeDeps();
		d.config.gateway.host = "0.0.0.0";
		await expect(startGateway(d)).rejects.toThrow(/loopback/);
	});
});

describe("幂等与归一化", () => {
	it("同事件重复投递：首次 2xx 入库、二次 2xx dedup 且不重复入库", async () => {
		const d = await start();
		const body = JSON.stringify({ fingerprint: "fp-1", severity: "high" });
		const first = await post(server!, "/webhook/alert", body, signedHeaders("alert", body));
		const second = await post(server!, "/webhook/alert", body, signedHeaders("alert", body));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.json.dedup).toBe(true);
		expect(d.sink.seenIds().filter((id) => id === "fp-1").length).toBe(1);
	});

	it("meegle：header.uuid 为幂等键，payload 段进入 event.payload", async () => {
		const d = await start();
		const body = JSON.stringify({
			header: { event_type: "workitem.created", uuid: "u-123" },
			payload: { id: 42, name: "修复登录失败", updated_at: 1727500000000 },
		});
		const res = await post(server!, "/webhook/meegle", body, signedHeaders("meegle", body));
		expect(res.status).toBe(200);
		const seen = d.sink.seenIds();
		expect(seen).toContain("u-123");
	});

	it("meegle 缺 header 段 → 422 显式拒绝", async () => {
		await start();
		const body = JSON.stringify({ payload: { id: 42 } });
		const res = await post(server!, "/webhook/meegle", body, signedHeaders("meegle", body));
		expect(res.status).toBe(422);
	});

	it("approval：ticketId 为幂等键", async () => {
		const d = await start();
		const body = JSON.stringify({ ticketId: "AP-7", decision: "approved" });
		const res = await post(server!, "/webhook/approval", body, signedHeaders("approval", body));
		expect(res.status).toBe(200);
		expect(d.sink.seenIds()).toContain("AP-7");
	});
});
