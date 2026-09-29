/**
 * 评测模式开关（DEV_SPEC §14 P4-6，技术方案 6.5 ⚠️）。
 *
 * 评测模式必须显式关闭或重置长期记忆召回，否则历史记忆会让被测 Agent
 * "开卷"，对照实验的结论作废。跑批前清空记忆并校验基线。
 *
 * 两档：
 *   - recall_off：仅关闭召回（记忆保留，跑完恢复）——A/B 同卷不同记忆
 *   - reset：    清空记忆 + 校验基线（空库跑通才算干净起跑）
 * 开关动作本身落 audit_logs（评测结论的可追溯性）。
 */

import type { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../memory/index.ts";

export interface EvalModeStatus {
	active: boolean;
	mode: "recall_off" | "reset" | null;
	memoryCount: number;
}

export class EvalMode {
	private active = false;
	private mode: "recall_off" | "reset" | null = null;

	constructor(
		private readonly db: DatabaseSync,
		private readonly store: MemoryStore,
	) {}

	/** 开启评测模式；reset=true 时先清空长期记忆 */
	enable(opts: { reset?: boolean; actor?: string } = {}): EvalModeStatus {
		if (opts.reset) {
			this.db.prepare("DELETE FROM memories").run();
		}
		this.store.setEvalMode(true);
		this.active = true;
		this.mode = opts.reset ? "reset" : "recall_off";
		this.db
			.prepare("INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES (?, ?, 'eval', 'eval-mode', 'enable', 'ok', ?)")
			.run(opts.actor ?? "evaluator", Date.now(), JSON.stringify({ mode: this.mode }));
		return this.status();
	}

	/** 关闭评测模式，恢复召回 */
	disable(actor = "evaluator"): EvalModeStatus {
		this.store.setEvalMode(false);
		this.active = false;
		this.mode = null;
		this.db
			.prepare("INSERT INTO audit_logs (actor, at, object_type, object_id, action, result, detail) VALUES (?, ?, 'eval', 'eval-mode', 'disable', 'ok', '{}')")
			.run(actor, Date.now());
		return this.status();
	}

	/** 基线校验：评测模式生效中（召回关闭/记忆清空）才允许起跑，否则实验作废 */
	validateBaseline(): { ok: boolean; reason?: string } {
		if (!this.active) return { ok: false, reason: "评测模式未开启，历史记忆会让被测 Agent 开卷" };
		if (this.mode === "reset") {
			const c = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
			if (c > 0) return { ok: false, reason: `reset 后仍有 ${c} 条记忆残留，基线不干净` };
		}
		return { ok: true };
	}

	status(): EvalModeStatus {
		const memoryCount = (this.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
		return { active: this.active, mode: this.mode, memoryCount };
	}
}
