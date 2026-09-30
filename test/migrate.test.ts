import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateUp, migrateDown, MIGRATIONS } from "../src/server/db/migrate.ts";

function freshDb(): DatabaseSync {
	return new DatabaseSync(":memory:");
}

describe("migrateUp", () => {
	it("全量迁移可重复执行（幂等）", () => {
		const db = freshDb();
		const first = migrateUp(db);
		const second = migrateUp(db);
		expect(first.length).toBe(MIGRATIONS.length);
		expect(second).toEqual([]);
	});

	it("建齐 6 张核心表 + schema_migrations；记忆已迁 RAG（memories 表不存在）", () => {
		const db = freshDb();
		migrateUp(db);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => (r as { name: string }).name);
		for (const t of [
			"webhook_events",
			"tasks",
			"task_events",
			"sessions",
			"approvals",
			"audit_logs",
			"schema_migrations",
		]) {
			expect(tables).toContain(t);
		}
		// 存储后端切换为 RAG 后，本地不再有 memories 表（完全替换）
		expect(tables).not.toContain("memories");
	});

	it("webhook_events.id 重复插入被主键拒绝（幂等去重键）", () => {
		const db = freshDb();
		migrateUp(db);
		const ins = db.prepare(
			"INSERT INTO webhook_events (id, source, type, occurred_at, ref, payload, raw, received_at) VALUES (?, 'alert', 'alert.fired', 0, 'r', '{}', '{}', 0)",
		);
		ins.run("evt-1");
		expect(() => ins.run("evt-1")).toThrow();
	});

	it("tasks.status 非法值被 CHECK 拒绝（状态机兜底）", () => {
		const db = freshDb();
		migrateUp(db);
		const ins = db.prepare(
			"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t1', 'alert', 'r', 'bogus', 0, 0)",
		);
		expect(() => ins.run()).toThrow();
	});
});

describe("append-only 保障", () => {
	it.each(["audit_logs", "task_events"])("%s 的 UPDATE/DELETE 被触发器拒绝", (table) => {
		const db = freshDb();
		migrateUp(db);
		if (table === "audit_logs") {
			db.prepare(
				"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result) VALUES ('a', 0, 't', 'i', 'x', 'ok')",
			).run();
			expect(() => db.exec(`UPDATE ${table} SET actor='b'`)).toThrow(/append-only/);
		} else {
			db.prepare(
				"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t1', 'alert', 'r', 'received', 0, 0)",
			).run();
			db.prepare(
				"INSERT INTO task_events (task_id, type, payload, created_at) VALUES ('t1', 'stage', '{}', 0)",
			).run();
			expect(() => db.exec(`UPDATE ${table} SET type='hacked'`)).toThrow(/append-only/);
		}
		expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
	});
});

describe("migrateDown", () => {
	it("回滚到 0 后核心表全部消失，可再次升上去", () => {
		const db = freshDb();
		migrateUp(db);
		const rolled = migrateDown(db, 0);
		expect(rolled.length).toBe(MIGRATIONS.length);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table'")
			.all()
			.map((r) => (r as { name: string }).name);
		expect(tables).not.toContain("tasks");
		expect(tables).not.toContain("audit_logs");
		// 再次升级仍可用（down/up 可重复）
		expect(migrateUp(db).length).toBe(MIGRATIONS.length);
	});

	it("触发器随迁移回滚被清理，表可正常 UPDATE", () => {
		const db = freshDb();
		migrateUp(db);
		migrateDown(db, 1); // 只回滚触发器迁移
		db.prepare(
			"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES ('t1', 'alert', 'r', 'received', 0, 0)",
		).run();
		// 触发器已删，UPDATE 应放行（tasks 本身不是 append-only）
		db.exec("UPDATE tasks SET status='triaged' WHERE id='t1'");
	});
});
