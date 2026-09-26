/**
 * 全局领域类型 —— 对齐《技术方案 - Vulcan agent.md》
 *
 * 三条 Webhook 链路（告警 / meegle 工单 / 审批）统一归一化为 InternalEvent，
 * 下游（Harness / Agent）只面向内部模型编程，不感知各来源 payload 细节。
 */

// ---------- 通用事件 ----------

export type EventSource = "alert" | "meegle" | "approval";

/** 归一化后的内部事件：所有 Webhook payload 统一转成这个模型 */
export interface InternalEvent {
	/** 事件唯一 ID，用于幂等去重（如 meegle 的 header.uuid） */
	id: string;
	source: EventSource;
	/** 语义类型，如 "alert.fired" / "workitem.created" / "approval.requested" */
	type: string;
	occurredAt: number;
	/** 关联对象（工单号 / 告警 fingerprint / 审批单号） */
	ref: string;
	payload: Record<string, unknown>;
	/** 原始 payload 快照，供审计 */
	raw: unknown;
}

// ---------- 告警 ----------

export type AlertSeverity = "critical" | "high" | "medium" | "low";

export interface AlertPayload {
	fingerprint: string;
	severity: AlertSeverity;
	title: string;
	description?: string;
	service?: string;
	startsAt?: number;
	labels: Record<string, string>;
}

// ---------- meegle 工单 ----------

/** 对齐 meegle webhook payload 的 header 段 */
export interface MeegleEventHeader {
	event_type: string;
	token?: string;
	uuid: string;
}

export interface MeegleWorkItem {
	id: number | string;
	name: string;
	project_key: string;
	work_item_type_key: string;
	status?: string;
	updated_at?: number;
}

// ---------- 审批 ----------

export type ApprovalDecision = "approved" | "rejected" | "manual";

/** 审批裁决输入：来自修复链路的产出，不只看 diff */
export interface ApprovalRequest {
	ticketId: string;
	/** 关联工单 / 告警 */
	ref: string;
	applicant: string;
	intent: string;
	changedFiles: string[];
	diffSummary: string;
	impactScope: string;
	/** 构建与测试证据 */
	evidence: {
		buildPassed: boolean;
		testsPassed: boolean;
		commands: string[];
	};
}

// ---------- 任务 ----------

export type TaskStatus =
	| "received"
	| "triaged"
	| "running"
	| "awaiting_approval"
	| "awaiting_manual"
	| "done"
	| "failed"
	| "rejected";

export interface VulcanTask {
	id: string;
	source: EventSource;
	ref: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
}
