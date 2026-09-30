/**
 * 评测模式开关（DEV_SPEC §14 P4-6，技术方案 6.5 ⚠️）——RAG 后端版。
 *
 * 评测模式必须显式关闭或重置长期记忆召回，否则历史记忆会让被测 Agent
 * "开卷"，对照实验的结论作废。跑批前清空记忆并校验基线。
 *
 * 两档：
 *   - recall_off：仅关闭召回（记忆保留，跑完恢复）——A/B 同卷不同记忆
 *   - reset：    清空记忆 + 校验基线（空库跑通才算干净起跑）
 *     清空走 RAG memory_manage clear（物理删除该 project 的分区）——
 *     status-only 的补丁不满足「基线可证明为空」的标准。
 *
 * 开关动作本身落本地 audit_logs（评测结论的可追溯性；审计不是记忆，留在 SQLite）。
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "../memory/index.ts";

export interface EvalModeStatus {
	active: boolean;
	mode: "recall_off" | "reset" | null;
	memoryCount: number;
}

export class EvalMode {
	private active = false;
	private mode: "recall_off" | "reset" | null = null;
	readonly #db: DatabaseSync;
	readonly #store: MemoryStore;
	readonly #project: string;

	constructor(db: DatabaseSync, store: MemoryStore, project: string) {
		this.#db = db;
		this.#store = store;
		this.#project = project;
	}

	/** 开启评测模式；reset=true 时先物理清空该 project 的记忆分区 */
	async enable(opts: { reset?: boolean; actor?: string } = {}): Promise<EvalModeStatus> {
		if (opts.reset) {
			await this.#store.resetPartition(this.#project);
		}
		this.#store.setEvalMode(true);
		this.active = true;
		this.mode = opts.reset ? "reset" : "recall_off";
		this.#db
			.prepare(
				"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES (?, ?, 'eval', 'eval-mode', 'enable', 'ok', ?)",
			)
			.run(opts.actor ?? "evaluator", Date.now(), JSON.stringify({ mode: this.mode, project: this.#project }));
		return this.status();
	}

	/** 关闭评测模式，恢复召回 */
	async disable(actor = "evaluator"): Promise<EvalModeStatus> {
		this.#store.setEvalMode(false);
		this.active = false;
		this.mode = null;
		this.#db
			.prepare(
				"INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES (?, ?, 'eval', 'eval-mode', 'disable', 'ok', '{}')",
			)
			.run(actor, Date.now());
		return this.status();
	}

	/** 基线校验：评测模式生效中（召回关闭/记忆清空）才允许起跑，否则实验作废 */
	async validateBaseline(): Promise<{ ok: boolean; reason?: string }> {
		if (!this.active) return { ok: false, reason: "评测模式未开启，历史记忆会让被测 Agent 开卷" };
		if (this.mode === "reset") {
			const c = await this.#store.countMemories(this.#project);
			if (c > 0) return { ok: false, reason: `reset 后仍有 ${c} 条记忆残留，基线不干净` };
		}
		return { ok: true };
	}

	async status(): Promise<EvalModeStatus> {
		const memoryCount = await this.#store.countMemories(this.#project);
		return { active: this.active, mode: this.mode, memoryCount };
	}
}
