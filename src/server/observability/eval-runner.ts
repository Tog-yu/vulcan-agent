/**
 * 历史 Bug 对照数据集评测跑批（DEV_SPEC §14 P5-3，技术方案 9.1/9.3 + 6.5）。
 *
 * 流程：开启评测模式（P4-6，防开卷）→ 校验基线 → 逐案例跑修复链路 →
 * 汇总端到端成功率 / 人工介入率 / 失败归因分布 → 产出对照报告 → 关闭评测模式。
 *
 * 案例数据集 = 历史 Bug 清单（事件 + 问题 + 预期结果），
 * 案例执行器由调用方注入（生产 = FixPipeline 适配器；测试 = mock runner）。
 * MemoryStore 由调用方注入并共享——评测模式开关对它直接生效。
 */

import type { DatabaseSync } from "node:sqlite";
import { EvalMode } from "./eval-mode.ts";
import { MemoryStore } from "../memory/index.ts";
import { attributionDistribution, type FailureCategory } from "./attribution.ts";

export interface EvalCase {
	/** 案例号（历史 Bug 的唯一标识） */
	caseId: string;
	/** 告警事件 ref（供 FixPipeline 组装 InternalEvent） */
	eventRef: string;
	/** 问题描述 */
	issue: string;
	/** 影响面（审批五输入之一） */
	impactScope?: string;
}

export type CaseOutcome = "pr_created" | "rejected" | "manual_review" | "budget_stopped" | "failed";

export interface CaseRunner {
	run(c: EvalCase): Promise<CaseOutcome>;
}

export interface EvalReport {
	/** 基线校验是否通过（评测模式生效） */
	baselineOk: boolean;
	baselineReason?: string;
	totalCases: number;
	/** 端到端成功率：pr_created / 总案例 */
	successRate: number;
	/** 人工介入率：manual_review / 总案例 */
	manualInterventionRate: number;
	/** 失败归因分布（对照 9.3 九类；来源 = audit_logs + 任务终态） */
	attribution: Record<FailureCategory, number>;
	/** 逐案例明细 */
	cases: Array<{ caseId: string; outcome: CaseOutcome }>;
}

export class EvalRunner {
	private readonly em: EvalMode;

	constructor(
		private readonly db: DatabaseSync,
		private readonly store: MemoryStore,
	) {
		this.em = new EvalMode(db, store);
	}

	async run(cases: EvalCase[], runner: CaseRunner, opts: { resetMemories?: boolean; actor?: string } = {}): Promise<EvalReport> {
		this.em.enable({ reset: opts.resetMemories, actor: opts.actor });
		const baseline = this.em.validateBaseline();

		const detail: Array<{ caseId: string; outcome: CaseOutcome }> = [];
		try {
			for (const c of cases) {
				detail.push({ caseId: c.caseId, outcome: await runner.run(c) });
			}
		} finally {
			// 跑批异常也必须退出评测模式，否则线上召回被永久关闭
			this.em.disable(opts.actor ?? "evaluator");
		}

		const success = detail.filter((d) => d.outcome === "pr_created").length;
		const manual = detail.filter((d) => d.outcome === "manual_review").length;
		return {
			baselineOk: baseline.ok,
			baselineReason: baseline.reason,
			totalCases: cases.length,
			successRate: cases.length > 0 ? success / cases.length : 0,
			manualInterventionRate: cases.length > 0 ? manual / cases.length : 0,
			attribution: attributionDistribution(this.db),
			cases: detail,
		};
	}
}
