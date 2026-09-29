import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { ApprovalEngine } from "../src/server/approval/engine.ts";
import { writeApprovalAudit } from "../src/server/approval/audit.ts";
import { ApprovalFlow } from "../src/server/approval/flow.ts";
import type { ApprovalRequest, InternalEvent } from "../src/server/types.ts";

function seed(): { db: DatabaseSync; flow: ApprovalFlow; ticketId: string; taskId: string } {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	// 任务走到 awaiting_manual
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-1', 'approval', 'AP-1', 'awaiting_manual', 0, 0)",
	).run();
	// 自动裁决落了 manual 行（system）
	db.prepare(
		"INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at) VALUES ('AP-1', 't-1', 'manual', '{}', '{}', '策略未覆盖', 'system', 0)",
	).run();
	const flow = new ApprovalFlow({ db });
	return { db, flow, ticketId: "AP-1", taskId: "t-1" };
}

function cbEvent(ticketId: string): InternalEvent {
	return { id: `evt-${ticketId}`, source: "approval", type: "approval.updated", occurredAt: Date.now(), ref: ticketId, payload: {}, raw: {} };
}

describe("P2-8 审批回调回流", () => {
	it("人工通过：任务 awaiting_manual → done（续跑不重开），审计留人工记录", () => {
		const { db, flow } = seed();
		const taskId = flow.handleCallback(cbEvent("AP-1"), { decision: "approved", decidedBy: "alice", reason: "LGTM" });
		expect(taskId).toBe("t-1");
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-1'").get() as { status: string }).status).toBe("done");
		const manual = db.prepare("SELECT * FROM approvals WHERE id='AP-1' AND decided_by='alice'").get() as Record<string, unknown>;
		expect(manual.decision).toBe("approved");
	// audit_logs 有人工裁决留痕（actor=alice, action=adjudicate）
	const audit = db.prepare("SELECT * FROM audit_logs WHERE actor='alice' AND action='adjudicate'").get() as Record<string, unknown> | undefined;
	expect(audit).toBeTruthy();
	});

	it("人工驳回：任务 → rejected", () => {
		const { db, flow } = seed();
		flow.handleCallback(cbEvent("AP-1"), { decision: "rejected", decidedBy: "bob", reason: "方案不对" });
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-1'").get() as { status: string }).status).toBe("rejected");
	});

	it("重复回调幂等：第二次人工裁决被跳过，状态不再变更", () => {
		const { db, flow } = seed();
		flow.handleCallback(cbEvent("AP-1"), { decision: "approved", decidedBy: "alice" });
		const again = flow.handleCallback(cbEvent("AP-1"), { decision: "rejected", decidedBy: "bob" });
		expect(again).toBeNull();
		// 状态保持第一次的 done
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-1'").get() as { status: string }).status).toBe("done");
		// 只有一条人工记录
		const n = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE id='AP-1' AND decided_by != 'system'").get() as { n: number };
		expect(Number(n.n)).toBe(1);
	});

	it("未知审批单 → 拒绝并告警", () => {
		const warns: string[] = [];
		const db = new DatabaseSync(":memory:");
		migrateUp(db);
		const flow = new ApprovalFlow({ db, onWarn: (m) => warns.push(m) });
		expect(flow.handleCallback(cbEvent("NOPE"), { decision: "approved", decidedBy: "x" })).toBeNull();
		expect(warns.length).toBe(1);
	});

	it("状态前置不满足（任务已被自动裁决为 done）→ 回调拒绝", () => {
		const { db, flow } = seed();
		db.prepare("UPDATE tasks SET status='done' WHERE id='t-1'").run();
		const warns: string[] = [];
		const flow2 = new ApprovalFlow({ db, onWarn: (m) => warns.push(m) });
		const r = flow2.handleCallback(cbEvent("AP-1"), { decision: "approved", decidedBy: "alice" });
		expect(r).toBeNull();
		expect(warns.length).toBe(1);
	});

	it("与策略引擎联动：engine 判 manual → 建审批行 → 人工回调收口", () => {
		const db = new DatabaseSync(":memory:");
		migrateUp(db);
		db.prepare(
			"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t-2', 'alert', 'fp-2', 'awaiting_approval', 0, 0)",
		).run();
		const engine = new ApprovalEngine();
		const request: ApprovalRequest = {
			ticketId: "AP-2", ref: "t-2", applicant: "agent", intent: "x",
			changedFiles: ["svc/src/a.ts"], diffSummary: "+1", impactScope: "svc",
			evidence: { buildPassed: true, testsPassed: true, commands: ["npm test"] },
		};
		const verdict = engine.decide(request);
		expect(verdict.decision).toBe("manual");
		writeApprovalAudit(db, { ticketId: "AP-2", taskId: "t-2", req: request, verdict, decidedBy: "system" });
		db.prepare("UPDATE tasks SET status='awaiting_manual' WHERE id='t-2'").run();
		const flow = new ApprovalFlow({ db });
		expect(flow.handleCallback(cbEvent("AP-2"), { decision: "approved", decidedBy: "carol" })).toBe("t-2");
		expect((db.prepare("SELECT status FROM tasks WHERE id='t-2'").get() as { status: string }).status).toBe("done");
	});
});
