import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config/index.ts";
import { normalizeAlert, normalizeApproval, normalizeMeegle } from "../src/server/gateway/normalize.ts";
import { EventQueue } from "../src/server/gateway/queue.ts";
import { GatewayServer, hmacSign, hmacVerify } from "../src/server/gateway/server.ts";

const SECRET = "test-secret";
const config = loadConfig();
const deps = {
	config,
	secretOf: () => SECRET,
	queue: new EventQueue(),
};

function makeRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
	const req = new Request(`http://localhost${path}`, {
		method,
		headers,
		body: body ?? (method === "POST" ? "{}" : undefined),
	});
	return { req: req as unknown as import("node:http").IncomingMessage, res: new MockResponse() };
}

class MockResponse {
	statusCode = 0;
	body = "";
	writeHead(status: number, _headers: Record<string, string>) {
		this.statusCode = status;
	}
	end(data?: string) {
		this.body = data ?? "";
	}
}

describe("hmac 鉴权", () => {
	it("正确签名通过，错误签名拒绝", () => {
		const body = '{"a":1}';
		expect(hmacVerify(SECRET, body, hmacSign(SECRET, body))).toBe(true);
		expect(hmacVerify(SECRET, body, "bad")).toBe(false);
		expect(hmacVerify(SECRET, body, undefined)).toBe(false);
	});
});

describe("normalize 归一化", () => {
	it("meegle payload 提取 header.uuid 与 event_type", () => {
		const ev = normalizeMeegle({ header: { event_type: "workitem.created", uuid: "u-1" }, payload: { id: 123 } });
		expect(ev.id).toBe("meegle:u-1");
		expect(ev.type).toBe("workitem.created");
		expect(ev.ref).toBe("123");
	});

	it("approval payload 提取 ticket_id", () => {
		const ev = normalizeApproval({ ticket_id: "T-9" });
		expect(ev.source).toBe("approval");
		expect(ev.ref).toBe("T-9");
	});

	it("alert payload 提取 severity 并容错", () => {
		const ev = normalizeAlert({
			alerts: [{ fingerprint: "fp1", labels: { alertname: "HighCPU", severity: "critical", service: "api" } }],
		});
		expect(ev.payload.severity).toBe("critical");
		expect(ev.ref).toBe("fp1");
	});
});

describe("幂等去重", () => {
	it("同 ID 第二次入队返回 false", () => {
		const q = new EventQueue();
		const ev = normalizeApproval({ ticket_id: "T-1" });
		expect(q.enqueue(ev)).toBe(true);
		expect(q.enqueue(ev)).toBe(false);
		expect(q.stats().duplicates).toBe(1);
	});
});

describe("GatewayServer.handleRequest", () => {
	it("healthz 返回 200", async () => {
		const gs = new GatewayServer(deps);
		const { req, res } = makeRequest("GET", "/healthz");
		await gs.handleRequest(req, res as never);
		expect(res.statusCode).toBe(200);
	});

	it("无签名 → 401；有效签名 → 200 且事件入队；重复投递 → duplicate", async () => {
		const queue = new EventQueue();
		const gs = new GatewayServer({ ...deps, queue });
		const body = JSON.stringify({ ticket_id: "T-42" });
		const sig = hmacSign(SECRET, body);

		const { req: r1, res: res1 } = makeRequest("POST", "/webhook/approval", body);
		await gs.handleRequest(r1, res1 as never);
		expect(res1.statusCode).toBe(401);

		const { req: r2, res: res2 } = makeRequest("POST", "/webhook/approval", body, { "x-vulcan-signature": sig });
		await gs.handleRequest(r2, res2 as never);
		expect(res2.statusCode).toBe(200);
		expect(JSON.parse(res2.body).status).toBe("accepted");
		expect(queue.stats().enqueued).toBe(1);

		const { req: r3, res: res3 } = makeRequest("POST", "/webhook/approval", body, { "x-vulcan-signature": sig });
		await gs.handleRequest(r3, res3 as never);
		expect(JSON.parse(res3.body).status).toBe("duplicate");
	});
});
