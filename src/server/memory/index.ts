/**
 * 长期记忆召回与失效（DEV_SPEC §14 P4-2，技术方案 6.4）。
 *
 * 召回：按权限（project）+ 相关性（关键词命中），限条数与总长度——
 *       否则长期记忆会挤出当前任务的信息。
 * 失效：
 *   - 带 code_version 的记忆在代码变更时标记 stale_candidate（markCodeVersionStale）
 *   - 超期无引用 → stale_candidate；复核后下线 → retired
 *   - 多条冲突按 verification_status 证据强度裁定，不按"谁更新谁赢"
 */

import type { DatabaseSync } from "node:sqlite";

/** verification_status 证据强度（冲突裁定用，高者胜） */
export const VERIFICATION_STRENGTH: Readonly<Record<string, number>> = {
	verified_by_test: 3,
	verified_by_human: 3,
	observed: 2,
	unverified: 1,
};

export interface MemoryRow {
	id: string;
	content: string;
	category: string;
	source: string;
	project: string;
	code_version: string | null;
	verification_status: string;
	expires_at: number | null;
	created_at: number;
	last_referenced_at: number | null;
	stale_status: string;
}

export interface RecallOptions {
	project: string;
	/** 相关性查询词（空 = 全量按预算召回） */
	query?: string;
	/** 最多返回条数（默认 5） */
	limit?: number;
	/** 返回内容总长度上限（字符，默认 4000） */
	maxTotalLength?: number;
}

export interface RecalledMemory {
	row: MemoryRow;
	/** 相关性得分（0 = 无查询词时的兜底召回） */
	score: number;
}

export class MemoryStore {
	constructor(
		private readonly db: DatabaseSync,
		/** 评测模式（P4-6）：显式关闭召回，防"开卷考试"污染对照实验 */
		private evalMode = false,
	) {}

	setEvalMode(on: boolean): void {
		this.evalMode = on;
	}

	/** 按权限 + 相关性召回，限条数与总长度；被评测模式显式关闭时返回空 */
	recall(opts: RecallOptions): RecalledMemory[] {
		if (this.evalMode) return [];

		const limit = opts.limit ?? 5;
		const maxLen = opts.maxTotalLength ?? 4000;
		const rows = this.db
			.prepare(
				`SELECT * FROM memories
				 WHERE project = ? AND stale_status = 'active'
				   AND (expires_at IS NULL OR expires_at > ?)
				 ORDER BY created_at DESC`,
			)
			.all(opts.project, Date.now()) as unknown as MemoryRow[];

		// 相关性打分：查询词命中数（大小写不敏感）；无查询词 = 0 分兜底
		const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const scored = rows.map((row) => {
			const content = row.content.toLowerCase();
			const score = terms.reduce((acc, t) => acc + (content.includes(t) ? 1 : 0), 0);
			return { row, score };
		});
		// 有查询词时按得分降序，0 分（不相关）淘汰；无查询词按时间新→旧
		scored.sort((a, b) => (terms.length ? b.score - a.score || b.row.created_at - a.row.created_at : b.row.created_at - a.row.created_at));
		const relevant = terms.length ? scored.filter((s) => s.score > 0) : scored;

		// 预算裁剪：限条数 + 限总长度
		const out: RecalledMemory[] = [];
		let totalLen = 0;
		for (const s of relevant) {
			if (out.length >= limit) break;
			if (totalLen + s.row.content.length > maxLen) continue;
			out.push(s);
			totalLen += s.row.content.length;
		}

		// 引用时间回写（超期无引用判定依据）
		if (out.length > 0) {
			const upd = this.db.prepare("UPDATE memories SET last_referenced_at = ? WHERE id = ?");
			for (const s of out) upd.run(Date.now(), s.row.id);
		}
		return out;
	}

	/** 代码版本变更：该版本范围的记忆标记待复核 */
	markCodeVersionStale(codeVersion: string): number {
		const r = this.db
			.prepare("UPDATE memories SET stale_status = 'stale_candidate' WHERE code_version = ? AND stale_status = 'active'")
			.run(codeVersion);
		return Number(r.changes);
	}

	/** 超期无引用 → 待复核（referenceTtlMs 内没有被 recall 引用过） */
	markUnreferencedStale(referenceTtlMs: number): number {
		const cutoff = Date.now() - referenceTtlMs;
		const r = this.db
			.prepare(
				`UPDATE memories SET stale_status = 'stale_candidate'
				 WHERE stale_status = 'active'
				   AND (last_referenced_at IS NULL AND created_at < ? OR last_referenced_at IS NOT NULL AND last_referenced_at < ?)`,
			)
			.run(cutoff, cutoff);
		return Number(r.changes);
	}

	/** 复核定论：confirm 保持/恢复 active，retire 下线 */
	resolveStale(id: string, decision: "confirm" | "retire"): boolean {
		const to = decision === "confirm" ? "active" : "retired";
		const r = this.db.prepare("UPDATE memories SET stale_status = ? WHERE id = ? AND stale_status = 'stale_candidate'").run(to, id);
		return Number(r.changes) === 1;
	}

	/**
	 * 冲突裁定：同 project + category 下多条内容互斥时，按 verification_status 证据强度
	 * 裁定保留哪条（不按"谁更新谁赢"）；落败方标记 stale_candidate 待复核。
	 */
	arbitrateConflict(project: string, category: string, keepId: string): string | null {
		const rows = this.db
			.prepare("SELECT id, verification_status FROM memories WHERE project = ? AND category = ? AND stale_status = 'active'")
			.all(project, category) as unknown as Array<{ id: string; verification_status: string }>;
		const keep = rows.find((r) => r.id === keepId);
		if (!keep) return null;
		const keepStrength = VERIFICATION_STRENGTH[keep.verification_status] ?? 0;
		const losers = rows.filter((r) => r.id !== keepId && (VERIFICATION_STRENGTH[r.verification_status] ?? 0) < keepStrength);
		const upd = this.db.prepare("UPDATE memories SET stale_status = 'stale_candidate' WHERE id = ?");
		for (const l of losers) upd.run(l.id);
		return losers.map((l) => l.id).join(",") || null;
	}
}
