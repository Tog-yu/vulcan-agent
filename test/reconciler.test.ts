import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { MeegleReconciler } from "../src/server/meegle/reconciler.ts";
import { EventQueue } from "../src/server/gateway/queue.ts";
import type { MeegleClient } from "../src/server/meegle/index.ts";
import type { InternalEvent } from "../src/server/types.ts";

const NOW = 1_800_000_000_000;

function fakeClient(items: Array<Record<string, unknown>>): MeegleClient {
	return {
		listWorkItemsByWindow: async () => ({ work_items: items }),
	} as unknown as MeegleClient;
}

function setup() {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	const queue = new EventQueue(db, { maxAttempts: 2, retryBaseMs: 1 });
	return { db, enqueue: (e: InternalEvent) => queue.tryEnqueue(e), queue };
}

describe("P2-4 meegle 对账兜底", () => {
	it("删除已投递事件后对账补齐：uuid 不在本地 → 补偿进队列", async () => {
		const { db, enqueue } = setup();
		// 本地已有工单1的事件（键 = 对账派生键），工单2的 webhook 丢了
		db.prepare(
			"INSERT INTO webhook_events (id, source, type, occurred_at, ref, payload, raw, received_at, status) VALUES (?, 'meegle', 'workitem.reconciled', 0, '1', '{}', '{}', 0, 'done')",
		).run(`reconcile:1:${NOW - 1000}`);
		const r = new MeegleReconciler({
			db,
			client: fakeClient([
				{ id: 1, updated_at: NOW - 1000 }, // 已知
				{ id: 2, updated_at: NOW - 500 }, // 丢了 → 补偿
			]),
			projectKey: "pj",
			enqueue,
		});
		const report = await r.reconcileOnce(NOW);
		expect(report.scanned).toBe(2);
		expect(report.compensated).toBe(1);
		expect(report.alreadyKnown).toBe(1);
		const n = db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE id = 'reconcile:2:" + (NOW - 500) + "'").get() as { n: number };
		expect(Number(n.n)).toBe(1);
	});

	it("对账幂等：同一轮工单重复跑两遍，不产生重复补偿", async () => {
		const { db, enqueue } = setup();
		const r = new MeegleReconciler({
			db,
			client: fakeClient([{ id: 9, updated_at: NOW - 100 }]),
			projectKey: "pj",
			enqueue,
		});
		const r1 = await r.reconcileOnce(NOW);
		const r2 = await r.reconcileOnce(NOW);
		expect(r1.compensated).toBe(1);
		expect(r2.compensated).toBe(0);
		expect(r2.alreadyKnown).toBe(1);
	});

	it("窗口重叠也安全：派生键 reconcile:<id>:<updated_at> 保证只补一次", async () => {
		const { db, enqueue } = setup();
		const r = new MeegleReconciler({
			db,
			client: fakeClient([{ id: 7, updated_at: NOW - 600_000 }]),
			projectKey: "pj",
			windowMs: 10 * 60_000,
			enqueue,
		});
		// 第二轮窗口往前推 1 秒（模拟周期触发窗口重叠），updated_at 仍在窗内 → 键相同 → 不重复
		const a = await r.reconcileOnce(NOW);
		const b = await r.reconcileOnce(NOW + 1000);
		expect(a.compensated).toBe(1);
		expect(b.compensated).toBe(0);
	});
});
