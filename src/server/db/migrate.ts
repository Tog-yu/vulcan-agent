/**
 * 迁移 runner + 全部建表迁移 —— 对齐 DEV_SPEC §5/§14(P1-2)。
 *
 * 设计（2026-09-28 拍板）：自研 mini runner —— SQL 迁移按序号执行，
 * schema_migrations 表记录已应用版本；每个迁移配 down（回滚 = 逐版本降序执行 down）。
 * 驱动：node:sqlite（内置，2026-09-28 拍板）。
 *
 * append-only 保障：audit_logs / task_events 用触发器禁 UPDATE/DELETE（DEV_SPEC §14 P1-2 验收）。
 */

import { DatabaseSync } from "node:sqlite";

export interface Migration {
	version: number;
	name: string;
	up: string;
	down: string;
}

/** 触发器名前缀，down 时按前缀清理 */
const APPEND_ONLY_TABLES = ["audit_logs", "task_events"];

function appendOnlyTriggers(table: string): { up: string; down: string } {
	return {
		up: `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update
BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only: UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only: DELETE forbidden');
END;`,
		down: `
DROP TRIGGER IF EXISTS ${table}_no_update;
DROP TRIGGER IF EXISTS ${table}_no_delete;`,
	};
}

export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "create-core-tables",
		up: `
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,               -- 事件唯一 ID（幂等去重键）
  source TEXT NOT NULL CHECK (source IN ('alert','meegle','approval')),
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ref TEXT NOT NULL,
  payload TEXT NOT NULL,             -- JSON
  raw TEXT NOT NULL,                 -- 原始 payload 快照（审计用）
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','dead'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('alert','meegle','approval')),
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'received','triaged','running','awaiting_approval',
    'awaiting_manual','done','failed','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source, ref);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  parent_event_id INTEGER REFERENCES task_events(id),  -- 树形分支，支持 Pi-style 回放
  type TEXT NOT NULL,
  payload TEXT NOT NULL,               -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_state TEXT NOT NULL,            -- 结构化任务状态 JSON（恒定 ~2K tokens）
  recent_window TEXT NOT NULL,         -- 近期对话原文 JSON（滚动窗口）
  early_summary TEXT                   -- 早期摘要（增量重写）
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','manual')),
  evidence_snapshot TEXT NOT NULL,     -- 输入证据快照 JSON
  matched_rules TEXT NOT NULL,         -- 命中的策略规则 JSON
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,            -- system / <具体人>
  decided_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'constraint_decision','verified_fix','failure_lesson','user_preference')),
  source TEXT NOT NULL,                -- 来源任务/工单/commit/文档
  project TEXT NOT NULL,
  code_version TEXT,
  verification_status TEXT NOT NULL CHECK (verification_status IN (
    'verified_by_test','verified_by_human','observed','unverified')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_referenced_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,                 -- 谁
  at INTEGER NOT NULL,                 -- 何时
  object_type TEXT NOT NULL,           -- 对什么
  object_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- 做了什么
  result TEXT NOT NULL,                -- 结果如何
  detail TEXT                          -- 补充 JSON（证据快照等）
);
`,
		down: `
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS webhook_events;`,
	},
];

/** 应用 append-only 触发器（独立小迁移，便于逐表回滚） */
for (const table of APPEND_ONLY_TABLES) {
	const { up, down } = appendOnlyTriggers(table);
	MIGRATIONS.push({
		version: MIGRATIONS.length + 1,
		name: `append-only-${table}`,
		up,
		down,
	});
}

/** v4：队列重试计数列 */
MIGRATIONS.push({
	version: 4,
	name: "webhook-events-attempts",
	up: "ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;",
	down: `
-- SQLite 3.35+ 支持 DROP COLUMN
ALTER TABLE webhook_events DROP COLUMN attempts;`,
});

/** v5：approvals 裁决记录补 append-only（P2-6 验收：尝试修改被数据库拒绝） */
{
	const { up, down } = appendOnlyTriggers("approvals");
	MIGRATIONS.push({ version: 5, name: "append-only-approvals", up, down });
}

/**
 * v6：approvals 主键改复合 (id, decided_by)（P2-8 修复）。
 *
 * 业务语义：一个审批单允许多条裁决记录 —— system 判 manual 一条 + 人工终态一条。
 * 原 id 单列主键导致人工回调追加裁决行时 UNIQUE 冲突。
 * SQLite 不能改主键 → 建新表搬数据再改名；注意 DROP TABLE 会连带删掉 v5 的
 * append-only 触发器，重建表后必须补建。
 */
{
	const triggers = appendOnlyTriggers("approvals");
	MIGRATIONS.push({
		version: 6,
		name: "approvals-composite-pk",
		up: `
CREATE TABLE approvals_new (
  id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','manual')),
  evidence_snapshot TEXT NOT NULL,
  matched_rules TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (id, decided_by)
);
INSERT INTO approvals_new (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at)
  SELECT id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
${triggers.up};`,
		down: `
${triggers.down}
CREATE TABLE approvals_old (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','manual')),
  evidence_snapshot TEXT NOT NULL,
  matched_rules TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);
-- 复合主键回退为单列：同 id 多行时按 decided_at 取最新一条（SQLite bare column 语义）
INSERT INTO approvals_old (id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at)
  SELECT id, task_id, decision, evidence_snapshot, matched_rules, reason, decided_by, decided_at
  FROM approvals GROUP BY id HAVING decided_at = MAX(decided_at);
DROP TABLE approvals;
ALTER TABLE approvals_old RENAME TO approvals;
${triggers.up};`,
	});
}

/**
 * v7：memories 加失效状态列（P4-2）。
 * stale_status: active / stale_candidate（待复核：代码版本变更或超期无引用）/ retired（复核后下线）。
 * 冲突裁定不改内容，只动 stale_status——保持原始记忆可追溯。
 */
MIGRATIONS.push({
	version: 7,
	name: "memories-stale-status",
	up: "ALTER TABLE memories ADD COLUMN stale_status TEXT NOT NULL DEFAULT 'active';",
	down: "ALTER TABLE memories DROP COLUMN stale_status;",
});

export function openDb(dbPath: string): DatabaseSync {
	return new DatabaseSync(dbPath);
}

/** 执行全部未应用的迁移（幂等：schema_migrations 已记录的版本跳过） */
export function migrateUp(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number[] {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
	const applied = new Set(
		db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number((r as { version: number }).version)),
	);
	const done: number[] = [];
	for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
		if (applied.has(m.version)) continue;
		db.exec("BEGIN");
		try {
			db.exec(m.up);
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				m.version,
				m.name,
				Date.now(),
			);
			db.exec("COMMIT");
			done.push(m.version);
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`迁移 v${m.version} (${m.name}) 失败：${(err as Error).message}`);
		}
	}
	return done;
}

/** 逐版本降序执行 down（回滚到 targetVersion，含 targetVersion 之上的全部版本） */
export function migrateDown(db: DatabaseSync, targetVersion: number, migrations: Migration[] = MIGRATIONS): number[] {
	const byVersion = new Map(migrations.map((m) => [m.version, m]));
	const applied = db
		.prepare("SELECT version FROM schema_migrations ORDER BY version DESC")
		.all()
		.map((r) => Number((r as { version: number }).version));
	const done: number[] = [];
	for (const v of applied) {
		if (v <= targetVersion) break;
		const m = byVersion.get(v);
		if (!m) throw new Error(`schema_migrations 中的 v${v} 在代码迁移清单中不存在`);
		db.exec("BEGIN");
		try {
			db.exec(m.down);
			db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(v);
			db.exec("COMMIT");
			done.push(v);
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`回滚 v${m.version} (${m.name}) 失败：${(err as Error).message}`);
		}
	}
	return done;
}
