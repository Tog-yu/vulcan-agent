/**
 * 审批审计写入（DEV_SPEC §14 P2-6，技术方案 8.4）。
 *
 * append-only：audit_logs 表已有触发器禁 UPDATE/DELETE（P1-2）。
 * 每次裁决记录：审批单号、裁决人（system/具体人）、时间、证据快照、命中规则、理由。
 * 写入失败视为 ERROR（审批结果不能没有留痕）——先写审计，后执行后续动作。
 */

import type { DatabaseSync } from "node:sqlite";
import type { Adjudication } from "./engine.ts";
import type { ApprovalRequest } from "../types.ts";

export interface AuditEntry {
	/** 审批单号 */
	ticketId: string;
	taskId: string;
	req: ApprovalRequest;
	verdict: Adjudication;
	/** system = 自动裁决；其他 = 人工审批人标识 */
	decidedBy: string;
	decidedAt?: number;
}

export function writeApprovalAudit(db: DatabaseSync, entry: AuditEntry): void {
	const evidenceSnapshot = JSON.stringify({
		intent: entry.req.intent,
		changedFiles: entry.req.changedFiles,
		diffSummary: entry.req.diffSummary,
		impactScope: entry.req.impactScope,
		evidence: entry.req.evidence,
		historyNote: entry.verdict.historyNote ?? null,
	});
	const matchedRules = JSON.stringify({
		deny: entry.verdict.matchedDeny,
		allowUnmet: entry.verdict.matchedAllowUnmet,
	});
	db.prepare(
		`INSERT INTO approvals (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		entry.ticketId,
		entry.taskId,
		entry.verdict.decision,
		evidenceSnapshot,
		matchedRules,
		entry.verdict.reasons.join("; "),
		entry.decidedBy,
		entry.decidedAt ?? Date.now(),
	);
	// 同步落全局审计日志（append-only 表）
	db.prepare(
		`INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail)
		 VALUES (?, ?, 'approval', ?, 'adjudicate', ?, ?)`,
	).run(
		entry.decidedBy,
		entry.decidedAt ?? Date.now(),
		entry.ticketId,
		entry.verdict.decision,
		JSON.stringify({ taskId: entry.taskId, reasons: entry.verdict.reasons }),
	);
}
