/**
 * payload 归一化：三来源 → InternalEvent（DEV_SPEC §14 P1-5，契约见 src/server/types.ts）。
 *
 * 未知/缺字段的 payload 显式拒绝（PermanentError），不做猜测性填充。
 */

import type { InternalEvent, EventSource } from "../types.ts";
import { NormalizeError } from "./errors.ts";

function requireString(obj: Record<string, unknown>, key: string, label: string): string {
	const v = obj[key];
	if (typeof v !== "string" || v.length === 0) {
		throw new NormalizeError(`${label}.${key} 缺失或非字符串`);
	}
	return v;
}

/** meegle header.uuid 去重键（src/server/types.ts:45-49） */
export function normalizeMeegle(payload: Record<string, unknown>): InternalEvent {
	const header = payload.header as Record<string, unknown> | undefined;
	if (!header || typeof header !== "object") {
		throw new NormalizeError("meegle payload 缺少 header 段");
	}
	const body = (payload.payload as Record<string, unknown> | undefined) ?? {};
	return {
		id: requireString(header, "uuid", "meegle.header"),
		source: "meegle",
		type: `workitem.${header.event_type ?? "unknown"}`,
		occurredAt: typeof body.updated_at === "number" ? body.updated_at : Date.now(),
		ref: body.id !== undefined ? String(body.id) : requireString(header, "event_type", "meegle.header"),
		payload: body,
		raw: payload,
	};
}

/** 告警：优先 fingerprint，缺失回退 title+startsAt 组合哈希语义（拼接，不引入依赖） */
export function normalizeAlert(payload: Record<string, unknown>): InternalEvent {
	const fingerprint = typeof payload.fingerprint === "string" && payload.fingerprint.length > 0
		? payload.fingerprint
		: `${payload.title ?? "unknown"}@${payload.startsAt ?? "unknown"}`;
	return {
		id: fingerprint,
		source: "alert",
		type: "alert.fired",
		occurredAt: typeof payload.startsAt === "number" ? payload.startsAt : Date.now(),
		ref: fingerprint,
		payload,
		raw: payload,
	};
}

/** 审批回调：以审批单号去重 */
export function normalizeApproval(payload: Record<string, unknown>): InternalEvent {
	return {
		id: requireString(payload, "ticketId", "approval"),
		source: "approval",
		type: "approval.updated",
		occurredAt: typeof payload.decidedAt === "number" ? payload.decidedAt : Date.now(),
		ref: requireString(payload, "ticketId", "approval"),
		payload,
		raw: payload,
	};
}

export function normalizeEvent(source: EventSource, payload: Record<string, unknown>): InternalEvent {
	switch (source) {
		case "alert":
			return normalizeAlert(payload);
		case "meegle":
			return normalizeMeegle(payload);
		case "approval":
			return normalizeApproval(payload);
	}
}
