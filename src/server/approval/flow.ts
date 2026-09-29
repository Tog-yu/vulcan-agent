/**
 * 审批回调回流（DEV_SPEC §14 P2-8，技术方案 8.3）。
 *
 * 人工在审批系统裁决 → Webhook 回调 /webhook/approval → gateway 归一化 →
 * 本模块消费：更新任务状态（awaiting_manual → done/rejected）+ 写审计 + 清升级状态。
 * 幂等：同 ticketId 已有终态裁决记录则跳过（不重复副作用）。
 * 任务从 awaiting_manual 继续，不重开任务（技术方案 8.3）。
 */

import type { DatabaseSync } from "node:sqlite";
import type { InternalEvent } from "../types.ts";
import { transitionTask } from "../harness/state-machine.ts";
import { writeApprovalAudit } from "./audit.ts";
import type { Adjudication } from "./engine.ts";

export interface ApprovalFlowDeps {
	db: DatabaseSync;
	onResolve?: (ticketId: string) => void;
	onWarn?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** 回调 payload（归一化后的 event.payload） */
export interface ManualDecisionPayload {
	/** 人工裁决：approved / rejected */
	decision: "approved" | "rejected";
	/** 人工审批人标识 */
	decidedBy: string;
	reason?: string;
}

export class ApprovalFlow {
	private readonly deps: ApprovalFlowDeps;

	constructor(deps: ApprovalFlowDeps) {
		this.deps = deps;
	}

	/** 查审批单对应的任务与当前状态 */
	private lookup(ticketId: string): { taskId: string; taskStatus: string } | null {
		const row = this.deps.db
			.prepare(
				`SELECT t.id AS task_id, t.status AS task_status FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`,
			)
			.get(ticketId) as { task_id: string; task_status: string } | undefined;
		return row ? { taskId: row.task_id, taskStatus: row.task_status } : null;
	}

	/**
	 * 消费审批回调事件（gateway 归一化后 type=approval.updated）。
	 * 返回处理的任务 ID；跳过（重复/非人工终态）返回 null。
	 */
	handleCallback(event: InternalEvent, payload: ManualDecisionPayload): string | null {
		const ticketId = event.ref;
		const found = this.lookup(ticketId);
		if (!found) {
			this.deps.onWarn?.("审批回调找不到对应审批单", { ticketId });
			return null;
		}

		// 幂等：同单已有人工终态裁决记录 → 跳过（人工回调可覆盖 system 的 manual 判定，不覆盖人工记录）
		const manualRecorded = this.deps.db
			.prepare("SELECT decided_by FROM approvals WHERE id = ? AND decided_by != 'system'")
			.get(ticketId);
		if (manualRecorded) {
			this.deps.onWarn?.("重复人工裁决回调，幂等跳过", { ticketId });
			return null;
		}

		const decision = payload.decision === "approved" ? "done" : "rejected";
		// awaiting_manual → done/rejected（非法前态（如已被自动裁决）会被流转表拒绝）
		const ok = transitionTask(this.deps.db, found.taskId, "awaiting_manual", decision);
		if (!ok) {
			this.deps.onWarn?.("任务状态前置条件不满足，回调拒绝", { ticketId, taskId: found.taskId, current: found.taskStatus });
			return null;
		}

		const verdict: Adjudication = {
			decision: payload.decision,
			reasons: [payload.reason ?? "人工裁决"],
			matchedDeny: [],
			matchedAllowUnmet: [],
		};
		// 人工结论记录 + 审计留痕（writeApprovalAudit 同时写 approvals 裁决行 + audit_logs）
		writeApprovalAudit(this.deps.db, {
			ticketId,
			taskId: found.taskId,
			req: {
				ticketId,
				ref: found.taskId,
				applicant: payload.decidedBy,
				intent: "人工回调裁决",
				changedFiles: [],
				diffSummary: "",
				impactScope: "",
				evidence: { buildPassed: true, testsPassed: true, commands: ["manual"] },
			},
			verdict,
			decidedBy: payload.decidedBy,
		});

		this.deps.onResolve?.(ticketId);
		return found.taskId;
	}
}
