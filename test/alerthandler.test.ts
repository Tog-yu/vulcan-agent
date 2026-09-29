import { describe, expect, it } from "vitest";
import { AlertHandler, groupKeyOf } from "../src/server/alerthandler/index.ts";
import type { InternalEvent } from "../src/server/types.ts";

function alertEvent(overrides: Partial<InternalEvent["payload"]> = {}, ref = "fp-1"): InternalEvent {
	return {
		id: `evt-${ref}`,
		source: "alert",
		type: "alert.fired",
		occurredAt: Date.now(),
		ref,
		payload: { service: "payment", severity: "high", title: "5xx 突增", ...overrides },
		raw: {},
	};
}

const ROUTING = {
	entries: [{ service: "payment", team: "payments-team", repo: "pay-svc" }],
	defaultTeam: "platform-team",
	defaultRepo: "unknown-repo",
};

describe("P2-1 alerthandler 去重降噪/分级/匹配", () => {
	it("同 group（服务+标题）在抑制窗口内合并：第二条 suppressed=true", () => {
		const h = new AlertHandler({ autofixAllowlist: {}, routing: ROUTING, suppressWindowMs: 60_000 });
		const d1 = h.route(alertEvent({}, "a"));
		const d2 = h.route(alertEvent({}, "b"));
		expect(d1.suppressed).toBe(false);
		expect(d2.suppressed).toBe(true);
		expect(d2.groupKey).toBe(d1.groupKey);
	});

	it("不同服务/标题不同 group，互不抑制", () => {
		const h = new AlertHandler({ autofixAllowlist: {}, routing: ROUTING, suppressWindowMs: 60_000 });
		const d1 = h.route(alertEvent({ service: "payment", title: "5xx 突增" }, "a"));
		const d2 = h.route(alertEvent({ service: "payment", title: "延迟飙高" }, "b"));
		const d3 = h.route(alertEvent({ service: "ledger", title: "5xx 突增" }, "c"));
		expect(d1.suppressed).toBe(false);
		expect(d2.suppressed).toBe(false);
		expect(d3.suppressed).toBe(false);
		expect(groupKeyOf({ ...alertEvent(), payload: { service: "payment", title: "x" } })).toBe("payment::x");
	});

	it("抑制窗口过期后同组告警重新放行", () => {
		const h = new AlertHandler({ autofixAllowlist: {}, routing: ROUTING, suppressWindowMs: 10 });
		h.route(alertEvent({}, "a"));
		const later = new AlertHandler({ autofixAllowlist: {}, routing: ROUTING, suppressWindowMs: 0 });
		const d = later.route(alertEvent({}, "b"));
		expect(d.suppressed).toBe(false);
	});

	it("分级与责任匹配：payment→payments-team/pay-svc；未知服务走兜底", () => {
		const h = new AlertHandler({ autofixAllowlist: {}, routing: ROUTING });
		const d1 = h.route(alertEvent({ service: "payment", severity: "critical" }));
		expect([d1.severity, d1.team, d1.repo]).toEqual(["critical", "payments-team", "pay-svc"]);
		const d2 = h.route(alertEvent({ service: "mystery", severity: "low" }));
		expect([d2.team, d2.repo]).toEqual(["platform-team", "unknown-repo"]);
	});
});

describe("P2-2 自动修复白名单", () => {
	it("白名单命中（service+severity 在允许清单）→ autofix=true", () => {
		const h = new AlertHandler({
			autofixAllowlist: { payment: ["critical", "high"] },
			routing: ROUTING,
		});
		expect(h.route(alertEvent({ severity: "high" })).autofix).toBe(true);
		expect(h.route(alertEvent({ severity: "critical" })).autofix).toBe(true);
	});

	it("白名单外（severity 不够/服务未配置）→ autofix=false，只出分析建议", () => {
		const h = new AlertHandler({
			autofixAllowlist: { payment: ["critical", "high"] },
			routing: ROUTING,
		});
		expect(h.route(alertEvent({ severity: "medium" })).autofix).toBe(false);
		expect(h.route(alertEvent({ service: "ledger", severity: "critical" })).autofix).toBe(false);
	});
});
