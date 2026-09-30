/**
 * 长期记忆召回与失效（DEV_SPEC §14 P4-2，技术方案 6.4）——RAG 后端版。
 *
 * 存储后端：本地 SQLite memories 表 → **MODULAR-RAG-MCP-SERVER**（混合检索
 * BM25+dense+RRF）。本类是 rag-bridge 之上的**业务门面**：保持 P4-2 的方法
 * 语义（召回预算 / 失效生命周期 / 证据强度裁定），把分区与生命周期动作翻译
 * 成 MCP 工具调用：
 *
 *   召回           → memory_search（相关模式）/ memory_manage list（全量模式）
 *   准入           → 门禁校验 + memory_store（带治理元数据）
 *   版本失效       → memory_manage mark_stale（按 code_version）
 *   按条目失效     → memory_manage mark_stale（按 entry_ids：冲突落败方 / 超期）
 *   复核           → memory_manage resolve（confirm 恢复 / retire 下线）
 *   评测 reset     → memory_manage clear（物理清分区，基线可证明为空）
 *
 * 权限模型不变：按 project 隔离（映射为 RAG 分区 repo/vulcan-<project>），
 * 限条数与总长度的预算裁剪在**本侧**做——否则长期记忆会挤出当前任务的信息。
 */

import { VERIFICATION_STRENGTH } from "./arbitration.ts";
import { type DenyReason, type MemoryCandidate, MemoryGate } from "./gate.ts";
import {
	generateEntryId,
	type ManageListEntry,
	type MemoryHit,
	type MemoryKind,
	RagMemoryBridge,
	type RagMemoryBridgeDeps,
} from "./rag-bridge.ts";

export { VERIFICATION_STRENGTH } from "./arbitration.ts";
export type { DenyReason, MemoryCandidate, MemoryCategory, VerificationStatus } from "./gate.ts";
export { MAX_MEMORY_TEXT_CHARS, MemoryGate } from "./gate.ts";
export {
	generateEntryId,
	partitionKey,
	RagMemoryBridge,
	sanitizeKey,
} from "./rag-bridge.ts";
export type { RagMcpConfig } from "./rag-transport.ts";
export { ragConfigFromEnv } from "./rag-transport.ts";

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
	id: string;
	category: MemoryKind;
	content: string;
	/** 相关性得分（全量召回 = 0；相关模式 = RAG 的 RRF 融合分，仅用于排序） */
	score: number;
	verification_status: string;
	code_version: string | null;
	source: string;
}

export interface AdmitResult {
	admitted: boolean;
	id?: string;
	reason?: string;
}

export interface DistillReport {
	candidates: number;
	admitted: number;
	denied: number;
	results: AdmitResult[];
}

export interface MemoryStoreDeps extends RagMemoryBridgeDeps {}

export class MemoryStore {
	readonly #bridge: RagMemoryBridge;
	/** 评测模式（P4-6）：显式关闭召回，防"开卷考试"污染对照实验 */
	#evalMode = false;

	constructor(deps: MemoryStoreDeps) {
		this.#bridge = new RagMemoryBridge(deps);
	}

	get bridge(): RagMemoryBridge {
		return this.#bridge;
	}

	setEvalMode(on: boolean): void {
		this.#evalMode = on;
	}

	async close(): Promise<void> {
		await this.#bridge.close();
	}

	// ─────────────────────────────────────────────────────────────────────
	// 写入（P4-1 门禁 → RAG memory_store）
	// ─────────────────────────────────────────────────────────────────────

	/** 单条准入：门禁校验后经 RAG 写入；拒绝时返回理由（不抛——拒绝是正常路径） */
	async admit(cand: MemoryCandidate): Promise<AdmitResult> {
		const reason = MemoryGate.check(cand);
		if (reason) return { admitted: false, reason };

		const id = generateEntryId();
		const r = await this.#bridge.store({
			project: cand.project,
			entryId: id,
			kind: cand.category,
			text: cand.content,
			verificationStatus: cand.verificationStatus,
			codeVersion: cand.codeVersion,
		});
		if (!r.ok) return { admitted: false, id, reason: `rag-store-failed: ${r.error ?? "unknown"}` };
		return { admitted: true, id };
	}

	// ─────────────────────────────────────────────────────────────────────
	// 召回（P4-2）
	// ─────────────────────────────────────────────────────────────────────

	/** 按权限（project 分区）+ 相关性召回，限条数与总长度；评测模式显式关闭时返回空 */
	async recall(opts: RecallOptions): Promise<RecalledMemory[]> {
		if (this.#evalMode) return [];

		const limit = opts.limit ?? 5;
		const maxLen = opts.maxTotalLength ?? 4000;

		let pool: RecalledMemory[];
		const query = (opts.query ?? "").trim();
		if (query.length > 0) {
			// 相关模式：混合检索（BM25+dense+RRF）。RAG 侧已滤 stale/forgotten。
			const out = await this.#bridge.search(opts.project, query, { topK: Math.max(limit, 20) });
			if (out.degraded) return []; // 降级 = 本轮无记忆可用，绝不抛
			pool = out.hits.map(toRecalled);
		} else {
			// 全量兜底召回：按创建时间新→旧（RAG search 必须给非空 query，走管理面枚举）
			const entries = await this.#bridge.listEntries(opts.project, { staleStatus: "" });
			pool = entries
				.filter((e) => e.status === "active")
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.map(entryToRecalled);
		}

		// 预算裁剪：限条数 + 限总长度（与原 SQLite 版同口径）
		const out: RecalledMemory[] = [];
		let totalLen = 0;
		for (const m of pool) {
			if (out.length >= limit) break;
			if (totalLen + m.content.length > maxLen) continue;
			out.push(m);
			totalLen += m.content.length;
		}
		return out;
	}

	// ─────────────────────────────────────────────────────────────────────
	// 失效生命周期（P4-2；全部分区约束）
	// ─────────────────────────────────────────────────────────────────────

	/** 代码版本变更：该版本范围的记忆标记待复核（返回标记条数） */
	async markCodeVersionStale(project: string, codeVersion: string): Promise<number> {
		const payload = await this.#bridge.manage(project, { action: "mark_stale", code_version: codeVersion });
		if (!payload) return 0;
		return typeof payload.marked === "number" ? payload.marked : 0;
	}

	/**
	 * 超期待复核（referenceTtlMs 内创建且此后一直未被复核过 → 标记待复核）。
	 *
	 * 注：RAG 侧没有「引用时间」概念（本地版回写 last_referenced_at 的职责已随
	 * SQLite 移除，服务端由 retention.ttl_days 承担过期），这里的 TTL 以
	 * **created_at** 为基准 —— 语义从「超期无引用」弱化为「超期未复核」，
	 * 覆盖场景是同一条：长期躺着的记忆该有人看一眼了。
	 */
	async markUnreferencedStale(project: string, referenceTtlMs: number): Promise<number> {
		const cutoff = Date.now() - referenceTtlMs;
		const entries = await this.#bridge.listEntries(project, { staleStatus: "" });
		const due = entries.filter((e) => {
			if (e.status !== "active") return false;
			const created = Date.parse(e.createdAt);
			return Number.isFinite(created) && created < cutoff;
		});
		return this.#bridge.markStaleByIds(
			project,
			due.map((e) => e.id),
		);
	}

	/** 复核定论：confirm 保持/恢复 active，retire 下线。返回是否生效 */
	async resolveStale(project: string, id: string, decision: "confirm" | "retire"): Promise<boolean> {
		return (await this.#bridge.resolve(project, [id], decision)) === 1;
	}

	/**
	 * 冲突裁定：同 project + category 下多条内容互斥时，按 verification_status 证据强度
	 * 裁定保留哪条（不按"谁更新谁赢"）；落败方标记待复核。
	 * 返回落败方 id（逗号连接）或 null（无落败方 / 保留对象不存在）。
	 */
	async arbitrateConflict(project: string, category: MemoryKind, keepId: string): Promise<string | null> {
		const entries = await this.#bridge.listEntries(project, { kind: category, staleStatus: "" });
		const active = entries.filter((e) => e.status === "active");
		const keep = active.find((e) => e.id === keepId);
		if (!keep) return null;
		const keepStrength = VERIFICATION_STRENGTH[keep.verificationStatus] ?? 0;
		const losers = active.filter(
			(e) => e.id !== keepId && (VERIFICATION_STRENGTH[e.verificationStatus] ?? 0) < keepStrength,
		);
		if (losers.length === 0) return null;
		const marked = await this.#bridge.markStaleByIds(
			project,
			losers.map((e) => e.id),
		);
		return marked > 0 ? losers.map((e) => e.id).join(",") : null;
	}

	// ─────────────────────────────────────────────────────────────────────
	// 评测支撑（P4-6）
	// ─────────────────────────────────────────────────────────────────────

	/** 分区内非 stale 记忆条数（评测基线 / 状态面用） */
	async countMemories(project: string): Promise<number> {
		const entries = await this.#bridge.listEntries(project, { staleStatus: "" });
		return entries.filter((e) => e.status === "active").length;
	}

	/** 评测 reset：物理清空分区，基线可证明为空 */
	async resetPartition(project: string): Promise<number> {
		return this.#bridge.clearPartition(project);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function toRecalled(hit: MemoryHit): RecalledMemory {
	return {
		id: hit.id,
		category: hit.kind,
		content: hit.text,
		score: hit.score,
		verification_status: hit.verificationStatus,
		code_version: hit.codeVersion || null,
		source: "",
	};
}

function entryToRecalled(e: ManageListEntry): RecalledMemory {
	return {
		id: e.id,
		category: e.kind,
		content: e.text,
		score: 0,
		verification_status: e.verificationStatus,
		code_version: e.codeVersion || null,
		source: "",
	};
}
