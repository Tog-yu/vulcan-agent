/**
 * meegle 对账兜底（DEV_SPEC §14 P2-4）。
 *
 * 原理：webhook 丢事件时，按时间窗拉取工单列表，与本地 webhook_events 对账——
 * 工单事件的幂等键（header.uuid）不在本地 → 补一条补偿事件进队列。
 * 对账按时间窗幂等：窗口重叠不会产生重复补偿（uuid 唯一键兜底）。
 */

import type { DatabaseSync } from "node:sqlite";
import type { MeegleClient } from "../meegle/index.ts";
import type { InternalEvent } from "../types.ts";

export interface ReconcilerDeps {
	db: DatabaseSync;
	client: MeegleClient;
	projectKey: string;
	/** 对账时间窗 ms（默认 10 分钟，向前回看） */
	windowMs?: number;
	/** 补偿事件投递口（通常接 EventQueue.tryEnqueue） */
	enqueue: (event: InternalEvent) => boolean;
}

export interface ReconcileReport {
	scanned: number;
	compensated: number;
	/** 窗口内本地已有的事件数（命中的部分） */
	alreadyKnown: number;
}

export class MeegleReconciler {
	private readonly deps: ReconcilerDeps;
	private readonly windowMs: number;

	constructor(deps: ReconcilerDeps) {
		this.deps = deps;
		this.windowMs = deps.windowMs ?? 10 * 60_000;
	}

	/** 跑一轮对账：返回补偿数。窗口按 [now-windowMs, now] 计算，调用方周期触发。 */
	async reconcileOnce(nowMs: number = Date.now()): Promise<ReconcileReport> {
		const from = nowMs - this.windowMs;
		const res = await this.deps.client.listWorkItemsByWindow(this.deps.projectKey, from, nowMs);
		const items = (res.work_items as Array<Record<string, unknown>> | undefined) ?? [];

		const report: ReconcileReport = { scanned: items.length, compensated: 0, alreadyKnown: 0 };
		const hasEvent = this.deps.db.prepare("SELECT 1 FROM webhook_events WHERE id = ?");

		for (const item of items) {
			// webhook 事件幂等键 = header.uuid；对账侧无法找回历史 uuid，
			// 用派生键 reconcile:<work_item_id>:<updated_at> 保证同一次更新只补一次
			const uuid = `reconcile:${String(item.id)}:${String(item.updated_at ?? from)}`;
			if (hasEvent.get(uuid)) {
				report.alreadyKnown++;
				continue;
			}
			const ok = this.deps.enqueue({
				id: uuid,
				source: "meegle",
				type: "workitem.reconciled",
				occurredAt: typeof item.updated_at === "number" ? item.updated_at : nowMs,
				ref: String(item.id ?? "unknown"),
				payload: item,
				raw: { reconciled: true, windowFrom: from, windowTo: nowMs },
			});
			if (ok) report.compensated++;
			else report.alreadyKnown++;
		}
		return report;
	}
}
