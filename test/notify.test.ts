import { describe, expect, it } from "vitest";
import { Notifier, ownerChainOf, type ManualContext } from "../src/server/notify/index.ts";

const CHAIN = {
	ticketOwner: "alice",
	codeOwner: "bob",
	teamLead: "carol",
	onDuty: "dave",
};

function ctx(overrides: Partial<ManualContext> = {}): ManualContext {
	return {
		ticketId: "AP-1",
		taskId: "t-1",
		intent: "修复 5xx",
		diffSummary: "+3 -1",
		impactScope: "pay-svc",
		evidenceSummary: "build ✓ tests ✓",
		reasons: ["策略未覆盖"],
		...overrides,
	};
}

function mockLark(log: Array<{ body: string }>, failStatus?: number) {
	return (async (_url: string | URL, init?: RequestInit) => {
		log.push({ body: String(init?.body ?? "") });
		return new Response("{}", { status: failStatus ?? 200 });
	}) as typeof fetch;
}

describe("P2-7 责任人路由", () => {
	it("路由阶梯：工单 owner → 代码 owner → 团队负责人 → 值班，去重去空", () => {
		expect(ownerChainOf(CHAIN)).toEqual(["alice", "bob", "carol", "dave"]);
		expect(ownerChainOf({ ...CHAIN, onDuty: undefined, codeOwner: "alice" })).toEqual(["alice", "carol"]);
	});

	it("转人工触发卡片推送，包含完整上下文包与 @ 责任人", async () => {
		const log: Array<{ body: string }> = [];
		const n = new Notifier({ larkWebhook: "https://lark.test/hook", fetchImpl: mockLark(log) });
		const ok = await n.sendManualReviewCard("alice", ctx());
		expect(ok).toBe(true);
		expect(log[0].body).toContain("alice");
		expect(log[0].body).toContain("修复 5xx");
		expect(log[0].body).toContain("策略未覆盖");
		expect(log[0].body).toContain("AP-1");
	});

	it("webhook 未配置 → 显式降级返回 false（不静默）", async () => {
		const warns: string[] = [];
		const n = new Notifier({ larkWebhook: null, onWarn: (m) => warns.push(m) });
		const ok = await n.sendManualReviewCard("alice", ctx());
		expect(ok).toBe(false);
		expect(warns.length).toBe(1);
	});

	it("推送失败（5xx）→ 返回 false", async () => {
		const log: Array<{ body: string }> = [];
		const n = new Notifier({ larkWebhook: "https://lark.test/hook", fetchImpl: mockLark(log, 500) });
		expect(await n.sendManualReviewCard("alice", ctx())).toBe(false);
	});
});

describe("P2-7 超时升级", () => {
	it("超时后逐级升级：alice → bob → carol → dave", async () => {
		let now = 1_000_000;
		const log: Array<{ body: string }> = [];
		const n = new Notifier({ larkWebhook: "https://lark.test/hook", fetchImpl: mockLark(log), now: () => now });
		await n.registerForApproval(CHAIN, ctx(), 60_000);
		expect(log.length).toBe(1);
		expect(log[0].body).toContain("alice");

		// 未超时 → null
		now += 30_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBeNull();

		// 超时 → 升到 bob
		now += 31_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBe("bob");
		expect(log[1].body).toContain("bob");

		// 再次超时 → carol → dave
		now += 61_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBe("carol");
		now += 61_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBe("dave");

		// 已到最末级 → 不再升级
		now += 61_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBeNull();
	});

	it("裁决回流后 resolve 清理状态，不再升级", async () => {
		let now = 1_000_000;
		const log: Array<{ body: string }> = [];
		const n = new Notifier({ larkWebhook: "https://lark.test/hook", fetchImpl: mockLark(log), now: () => now });
		await n.registerForApproval(CHAIN, ctx(), 60_000);
		n.resolve("AP-1");
		now += 120_000;
		expect(await n.escalateIfExpired("AP-1", 60_000, ctx())).toBeNull();
	});
});
