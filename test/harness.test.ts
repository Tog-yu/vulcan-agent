import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp } from "../src/server/db/migrate.ts";
import { canTransition, transitionTask, IllegalTransitionError, TRANSITIONS } from "../src/server/harness/state-machine.ts";
import { Harness } from "../src/server/harness/index.ts";
import type { InternalEvent, TaskStatus } from "../src/server/types.ts";

const ALL: TaskStatus[] = [
	"received", "triaged", "running", "awaiting_approval",
	"awaiting_manual", "done", "failed", "rejected",
];

function setupDb() {
	const db = new DatabaseSync(":memory:");
	migrateUp(db);
	return db;
}

function insertTask(db: DatabaseSync, id: string, status: TaskStatus) {
	db.prepare(
		"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, 'alert', 'r', ?, 0, 0)",
	).run(id, status);
}

describe("状态机流转表", () => {
	it("非法流转 running→received / done→running / rejected→running 全部被拒", () => {
		expect(canTransition("running", "received")).toBe(false);
		expect(canTransition("done", "running")).toBe(false);
		expect(canTransition("rejected", "running")).toBe(false);
		expect(canTransition("failed", "running")).toBe(false);
	});

	it("主链路流转全部可达：received→triaged→running→awaiting_approval→done", () => {
		expect(canTransition("received", "triaged")).toBe(true);
		expect(canTransition("triaged", "running")).toBe(true);
		expect(canTransition("running", "awaiting_approval")).toBe(true);
		expect(canTransition("awaiting_approval", "done")).toBe(true);
		expect(canTransition("awaiting_approval", "rejected")).toBe(true);
		expect(canTransition("awaiting_approval", "awaiting_manual")).toBe(true);
		expect(canTransition("awaiting_manual", "done")).toBe(true);
		expect(canTransition("running", "failed")).toBe(true);
	});

	it("终态 done/failed/rejected 无出边", () => {
		for (const terminal of ["done", "failed", "rejected"] as TaskStatus[]) {
			expect(TRANSITIONS[terminal]).toEqual([]);
		}
	});

	it("transitionTask DB 前置条件：状态匹配才流转", () => {
		const db = setupDb();
		insertTask(db, "t1", "received");
		expect(transitionTask(db, "t1", "received", "triaged")).toBe(true);
		expect((db.prepare("SELECT status FROM tasks WHERE id='t1'").get() as { status: string }).status).toBe("triaged");
		// 再执行同一次流转：前态已不符 → false（而非报错）
		expect(transitionTask(db, "t1", "received", "triaged")).toBe(false);
	});

	it("transitionTask 非法流转直接抛 IllegalTransitionError", () => {
		const db = setupDb();
		insertTask(db, "t1", "running");
		expect(() => transitionTask(db, "t1", "running", "received")).toThrow(IllegalTransitionError);
	});
});

describe("Harness 编排", () => {
	function evt(source: InternalEvent["source"], ref: string): InternalEvent {
		return { id: `e-${source}-${ref}`, source, type: `${source}.x`, occurredAt: 0, ref, payload: {}, raw: {} };
	}

	it("事件路由到正确 handler（alert/meegle/approval）", async () => {
		const db = setupDb();
		const routed: string[] = [];
		const h = new Harness({
			db,
			routes: {
				alert: async () => void routed.push("alert"),
				meegle: async () => void routed.push("meegle"),
				approval: async () => void routed.push("approval"),
			},
		});
		await h.handleEvent(evt("alert", "A1"));
		await h.handleEvent(evt("meegle", "M1"));
		await h.handleEvent(evt("approval", "P1"));
		expect(routed).toEqual(["alert", "meegle", "approval"]);
	});

	it("同 (source, ref) 重复事件复用任务不重复建", async () => {
		const db = setupDb();
		const h = new Harness({ db, routes: {} });
		const first = h.getOrCreateTask(evt("alert", "A1"));
		const second = h.getOrCreateTask(evt("alert", "A1"));
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.taskId).toBe(first.taskId);
		const n = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
		expect(Number(n.n)).toBe(1);
	});

	it("Harness.transition 非法流转：拒绝并触发 onWarn 告警", async () => {
		const db = setupDb();
		insertTask(db, "t1", "running");
		const warns: string[] = [];
		const h = new Harness({ db, routes: {}, onWarn: (msg) => warns.push(msg) });
		expect(() => h.transition("t1", "running", "received")).toThrow(IllegalTransitionError);
		expect(warns.length).toBe(1);
	});

	it("Harness.transition 合法流转：DB 状态实际变更", async () => {
		const db = setupDb();
		insertTask(db, "t1", "awaiting_approval");
		const h = new Harness({ db, routes: {} });
		h.transition("t1", "awaiting_approval", "done");
		expect((db.prepare("SELECT status FROM tasks WHERE id='t1'").get() as { status: string }).status).toBe("done");
	});
});
