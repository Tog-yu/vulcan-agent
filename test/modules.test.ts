import { describe, expect, it } from "vitest";
import { AlertHandler } from "../src/server/alerthandler/index.ts";
import { ApprovalService, DEFAULT_POLICY } from "../src/server/approval/index.ts";
import { PluginRegistry } from "../src/server/cordis/index.ts";
import { MemoryStore } from "../src/server/memory/index.ts";
import { NotifyService } from "../src/server/notify/index.ts";

const makeApproval = (overrides: Partial<Parameters<ApprovalService["decide"]>[0]> = {}) => ({
	ticketId: "T-1",
	ref: "ref-1",
	applicant: "tog",
	intent: "fix logging",
	changedFiles: ["src/a.ts"],
	diffSummary: "+ console.log",
	impactScope: "api",
	evidence: { buildPassed: true, testsPassed: true, commands: ["npm test"] },
	...overrides,
});

describe("审批三态裁决", () => {
	const svc = new ApprovalService({
		policy: DEFAULT_POLICY,
		notify: new NotifyService({ env: {}, larkWebhookEnv: "NOPE" }),
	});

	it("全部规则满足 → approved", () => {
		expect(svc.decide(makeApproval()).decision).toBe("approved");
	});

	it("命中禁止路径 → 直接驳回（不转人工）", () => {
		const v = svc.decide(makeApproval({ changedFiles: ["config/prod/x.yaml"] }));
		expect(v.decision).toBe("rejected");
	});

	it("diff 命中禁止关键词 → 直接驳回", () => {
		expect(svc.decide(makeApproval({ diffSummary: "DROP TABLE users" })).decision).toBe("rejected");
	});

	it("文件数超限 / 测试未过 → 转人工", () => {
		expect(
			svc.decide(makeApproval({ changedFiles: Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`) })).decision,
		).toBe("manual");
		expect(
			svc.decide(makeApproval({ evidence: { buildPassed: true, testsPassed: false, commands: [] } })).decision,
		).toBe("manual");
	});
});

describe("告警处理", () => {
	it("白名单外服务只给建议；窗口内重复告警合并", () => {
		const h = new AlertHandler({ autoFixWhitelist: new Set(["web"]) });
		const ev = {
			id: "a:1",
			source: "alert" as const,
			type: "alert.fired",
			ref: "fp1",
			occurredAt: 0,
			payload: { fingerprint: "fp1", severity: "low", service: "batch-job" },
			raw: null,
		};
		expect(h.handle(ev).action).toBe("advise_only");
		ev.payload = { fingerprint: "fp2", severity: "low", service: "web" };
		expect(h.handle(ev).action).toBe("auto_fix");
		expect(h.handle(ev).action).toBe("merged");
	});
});

describe("记忆写入", () => {
	it("未校验的记忆拒绝入库", () => {
		const m = new MemoryStore();
		expect(m.write({ content: "猜测", scopes: ["team"], sourceTaskId: "t1", verified: false })).toBeNull();
		const rec = m.write({ content: "已知经验", scopes: ["team"], sourceTaskId: "t1", verified: true });
		expect(rec).not.toBeNull();
		expect(m.recall("经验", ["team"]).length).toBe(1);
	});
});

describe("插件注册表", () => {
	it("重名注册报错；setupAll 逐个装配", async () => {
		const reg = new PluginRegistry();
		const p = { name: "p1", kind: "tool" as const, setup: async () => {}, tools: [] };
		reg.register(p);
		expect(() => reg.register(p)).toThrow();
		const logs: string[] = [];
		await reg.setupAll({ config: {}, logger: (m) => logs.push(m) });
		expect(logs.length).toBe(1);
	});
});
