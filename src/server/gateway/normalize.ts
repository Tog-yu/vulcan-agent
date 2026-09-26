/**
 * payload 归一化 —— 各来源原始 payload → InternalEvent。
 * 技术方案 七：下游只面向内部模型编程。
 */

import type { AlertSeverity, EventSource, InternalEvent } from "../types.ts";

function baseEvent(
	source: EventSource,
	id: string,
	type: string,
	ref: string,
	payload: Record<string, unknown>,
	raw: unknown,
): InternalEvent {
	return { id: `${source}:${id}`, source, type, ref, occurredAt: Date.now(), payload, raw };
}

// ---------- alert ----------

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

function asSeverity(v: unknown): AlertSeverity {
	const s = String(v ?? "").toLowerCase();
	return (SEVERITY_ORDER as readonly string[]).includes(s) ? (s as AlertSeverity) : "medium";
}

export function normalizeAlert(raw: unknown): InternalEvent {
	const body = (raw ?? {}) as Record<string, unknown>;
	// Alertmanager 风格：alerts[] + 通用字段；其余告警源在接入时补充适配
	const alerts = Array.isArray(body.alerts) ? body.alerts : [body];
	const first = (alerts[0] ?? {}) as Record<string, unknown>;
	const labels = (first.labels ?? {}) as Record<string, string>;
	const fingerprint = String(first.fingerprint ?? labels.alertname ?? crypto.randomUUID());
	return baseEvent(
		"alert",
		fingerprint,
		"alert.fired",
		fingerprint,
		{
			severity: asSeverity(labels.severity ?? first.severity),
			title: String(labels.alertname ?? first.title ?? "unknown alert"),
			description: first.description,
			service: labels.service,
			labels,
			groupSize: alerts.length,
		},
		raw,
	);
}

// ---------- meegle ----------

/** 对齐 meegle webhook payload：{ header: { event_type, uuid, ... }, payload: { ... } } */
export function normalizeMeegle(raw: unknown): InternalEvent {
	const body = (raw ?? {}) as Record<string, unknown>;
	const header = (body.header ?? {}) as Record<string, unknown>;
	const payload = (body.payload ?? {}) as Record<string, unknown>;
	const uuid = String(header.uuid ?? crypto.randomUUID());
	const workItemId = payload.id ?? payload.work_item_id ?? "unknown";
	return baseEvent("meegle", uuid, String(header.event_type ?? "workitem.unknown"), String(workItemId), payload, raw);
}

// ---------- approval ----------

export function normalizeApproval(raw: unknown): InternalEvent {
	const body = (raw ?? {}) as Record<string, unknown>;
	const ticketId = String(body.ticket_id ?? body.ticketId ?? crypto.randomUUID());
	return baseEvent("approval", ticketId, "approval.requested", ticketId, body, raw);
}
