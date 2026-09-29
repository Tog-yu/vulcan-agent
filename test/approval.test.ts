import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { ApprovalEngine, BUILTIN_DENY_RULES, DEFAULT_POLICY, type PolicyConfig } from "../src/server/approval/engine.ts";
import { writeApprovalAudit } from "../src/server/approval/audit.ts";
import type { ApprovalRequest } from "../src/server/types.ts";

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		ticketId: "AP-1",
		ref: "task-1",
		applicant: "agent",
		intent: "修复支付服务 5xx 突增",
		changedFiles: ["pay-svc/src/handler.ts"],
		diffSummary: "+3 -1",
		impactScope: "pay-svc",
		evidence: { buildPassed: true, testsPassed: true, commands: ["npm test"] },
		...overrides,
	};
}

describe("P2-5 审批三态裁决", () => {
	it("命中禁止项（生产配置）→ 100% rejected，不降级转人工", () => {
		const e = new ApprovalEngine();
		const v = e.decide(req({ changedFiles: ["pay-svc/config/prod/settings.yaml"] }));
		expect(v.decision).toBe("rejected");
		expect(v.matchedDeny).toContain("prod-config");
	});

	it.each(BUILTIN_DENY_RULES.map((r) => [r.id, r] as const))("禁止项 %s 命中即驳回", (id, rule) => {
		const e = new ApprovalEngine();
		const byId: Record<string, ApprovalRequest> = {
			"prod-config": req({ changedFiles: ["svc/config/prod/a.yaml"] }),
			"data-migration": req({ changedFiles: ["svc/db/migration_001.sql"] }),
			"cross-repo": req({ changedFiles: ["repoA/a.ts", "repoB/b.ts"] }),
			"huge-diff": req({ changedFiles: Array.from({ length: 51 }, (_, i) => `svc/f${i}.ts`) }),
			"no-evidence": req({ evidence: { buildPassed: true, testsPassed: false, commands: [] } }),
		};
		const v = e.decide(byId[id]);
		expect(v.decision).toBe("rejected");
		expect(v.matchedDeny).toContain(id);
	});

	it("全条件满足 + allow 规则全过 → approved", () => {
		const policy: PolicyConfig = {
			deny: BUILTIN_DENY_RULES,
			allow: [
				{ id: "test-only", test: (r) => r.changedFiles.every((f) => /test|spec/i.test(f)), why: "仅限测试目录" },
				{ id: "small", test: (r) => r.changedFiles.length <= 10, why: "变更文件数 ≤ 10" },
			],
		};
		const e = new ApprovalEngine(policy);
		const v = e.decide(req({ changedFiles: ["pay-svc/test/handler.test.ts"] }));
		expect(v.decision).toBe("approved");
	});

	it("无禁止项但 allow 未全满足 → manual（不放宽）", () => {
		const policy: PolicyConfig = {
			deny: BUILTIN_DENY_RULES,
			allow: [{ id: "test-only", test: (r) => r.changedFiles.every((f) => /test/i.test(f)), why: "仅限测试目录" }],
		};
		const e = new ApprovalEngine(policy);
		const v = e.decide(req({ changedFiles: ["pay-svc/src/handler.ts"] }));
		expect(v.decision).toBe("manual");
	});

	it("默认策略（无 allow）→ 永远不可能 approved：非禁止项也转人工", () => {
		const e = new ApprovalEngine(DEFAULT_POLICY);
		const v = e.decide(req());
		expect(v.decision).toBe("manual");
		expect(v.reasons[0]).toContain("从严");
	});

	it("策略规则抛错 → 从严转人工（不放行）", () => {
		const policy: PolicyConfig = {
			deny: BUILTIN_DENY_RULES,
			allow: [{ id: "boom", test: () => { throw new Error("policy bug"); }, why: "never" }],
		};
		const e = new ApprovalEngine(policy);
		const v = e.decide(req());
		expect(v.decision).toBe("manual");
		expect(v.reasons[0]).toContain("策略引擎异常");
	});
});

describe("P2-6 审计写入", () => {
	function dbWithTask(): DatabaseSync {
		const db = new DatabaseSync(":memory:");
		migrateUp(db);
		db.prepare(
			"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-1', 'alert', 'fp-1', 'awaiting_approval', 0, 0)",
		).run();
		return db;
	}

	it("每次裁决产生完整审计记录（approvals + audit_logs），字段齐全", () => {
		const db = dbWithTask();
		const e = new ApprovalEngine();
		const v = e.decide(req({ changedFiles: ["svc/config/prod/x.yaml"] }));
		writeApprovalAudit(db, { ticketId: "AP-9", taskId: "t-1", req: req({ changedFiles: ["svc/config/prod/x.yaml"] }), verdict: v, decidedBy: "system" });

		const a = db.prepare("SELECT * FROM approvals WHERE id='AP-9'").get() as Record<string, unknown>;
		expect(a.decision).toBe("rejected");
		expect(a.decided_by).toBe("system");
		expect(String(a.evidence_snapshot)).toContain("prod");
		expect(String(a.matched_rules)).toContain("prod-config");
		expect(String(a.reason)).toContain("生产配置");

		const l = db.prepare("SELECT * FROM audit_logs WHERE object_id='AP-9'").get() as Record<string, unknown>;
		expect(l.action).toBe("adjudicate");
		expect(l.result).toBe("rejected");
	});

	it("审计 append-only：裁决记录 UPDATE/DELETE 被 DB 拒绝", () => {
		const db = dbWithTask();
		const e = new ApprovalEngine();
		writeApprovalAudit(db, { ticketId: "AP-9", taskId: "t-1", req: req(), verdict: e.decide(req()), decidedBy: "system" });
		expect(() => db.exec("UPDATE approvals SET decision='approved' WHERE id='AP-9'")).toThrow();
		expect(() => db.exec("DELETE FROM audit_logs")).toThrow();
	});
});
