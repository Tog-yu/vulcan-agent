import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { EventQueue } from "../src/server/gateway/queue.ts";
import type { InternalEvent } from "../src/server/types.ts";

function setup() {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	return db;
}

function evt(id: string, source: InternalEvent["source"] = "alert"): InternalEvent {
	return { id, source, type: `${source}.test`, occurredAt: 0, ref: "r1", payload: { k: 1 }, raw: { k: 1 } };
}

describe("EventQueue 幂等", () => {
	it("同 ID 重复入队：首次 true，二次 false，库中仅一条", () => {
		const db = setup();
		const q = new EventQueue(db, { maxAttempts: 3 });
		expect(q.tryEnqueue(evt("e1"))).toBe(true);
		expect(q.tryEnqueue(evt("e1"))).toBe(false);
		const n = db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get() as { n: number };
		expect(Number(n.n)).toBe(1);
	});
});

describe("EventQueue 消费与重试", () => {
	it("成功路径：queued → processing → done", async () => {
		const db = setup();
		const q = new EventQueue(db, { maxAttempts: 3 });
		q.tryEnqueue(evt("e1"));
		const handled: string[] = [];
		let running = true;
		await q.run(
			async (e) => {
				handled.push(e.id);
			},
			() => {
				// 处理完第一条即停
				if (handled.length >= 1) running = false;
				return running;
			},
		);
		expect(handled).toEqual(["e1"]);
		const status = (db.prepare("SELECT status FROM webhook_events WHERE id='e1'").get() as { status: string }).status;
		expect(status).toBe("done");
		expect(q.deadCount()).toBe(0);
	});

	it("失败重试 maxAttempts 次后进死信，onDead 触发", async () => {
		const db = setup();
		const dead: string[] = [];
		const errors: number[] = [];
		const q = new EventQueue(db, {
			maxAttempts: 3,
			retryBaseMs: 1,
			onError: (_e, _err, attempt) => errors.push(attempt),
			onDead: (e) => dead.push(e.id),
		});
		q.tryEnqueue(evt("e-bad"));
		let running = true;
		await q.run(
			async () => {
				throw new Error("boom");
			},
			() => {
				if (dead.length >= 1) running = false;
				return running;
			},
		);
		expect(errors).toEqual([1, 2, 3]);
		expect(dead).toEqual(["e-bad"]);
		expect(q.deadCount()).toBe(1);
		const status = (db.prepare("SELECT status FROM webhook_events WHERE id='e-bad'").get() as { status: string }).status;
		expect(status).toBe("dead");
	});

	it("第二次才成功：不进死信，重试后 done", async () => {
		const db = setup();
		let calls = 0;
		const q = new EventQueue(db, { maxAttempts: 3, retryBaseMs: 1 });
		q.tryEnqueue(evt("e-flaky"));
		let running = true;
		await q.run(
			async () => {
				calls++;
				if (calls === 1) throw new Error("flaky");
			},
			() => {
				if (calls >= 2) running = false;
				return running;
			},
		);
		const status = (db.prepare("SELECT status FROM webhook_events WHERE id='e-flaky'").get() as { status: string }).status;
		expect(status).toBe("done");
		expect(q.deadCount()).toBe(0);
	});
});

describe("EventQueue 崩溃恢复", () => {
	it("recoverInterrupted 把遗留 processing 重置为 queued，重启后重放", async () => {
		const db = setup();
		const q = new EventQueue(db, { maxAttempts: 3 });
		q.tryEnqueue(evt("e-crash"));
		// 模拟崩溃：事件被标 processing 后进程死亡
		db.prepare("UPDATE webhook_events SET status='processing' WHERE id='e-crash'").run();
		// 直接 UPDATE webhook_events 会撞 append-only 触发器吗？——不会：
		// append-only 只加在 task_events / audit_logs；webhook_events 允许状态流转 UPDATE。
		const recovered = q.recoverInterrupted();
		expect(recovered).toBe(1);
		const handled: string[] = [];
		let running = true;
		await q.run(
			async (e) => {
				handled.push(e.id);
			},
			() => {
				if (handled.length >= 1) running = false;
				return running;
			},
		);
		expect(handled).toEqual(["e-crash"]);
	});

	it("kill -9 场景语义：handler 副作用幂等由下游幂等键保证（此处验证重放不丢事件）", async () => {
		const db = setup();
		const q = new EventQueue(db, { maxAttempts: 2, retryBaseMs: 1 });
		for (const id of ["a", "b", "c"]) q.tryEnqueue(evt(id));
		db.prepare("UPDATE webhook_events SET status='processing' WHERE id IN ('a','b')").run();
		expect(q.recoverInterrupted()).toBe(2);
		const handled: string[] = [];
		let running = true;
		await q.run(
			async (e) => {
				handled.push(e.id);
			},
			() => {
				if (handled.length >= 3) running = false;
				return running;
			},
		);
		expect(handled.sort()).toEqual(["a", "b", "c"]);
	});
});
