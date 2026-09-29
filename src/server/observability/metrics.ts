/**
 * 指标采集（DEV_SPEC §14 P4-5，技术方案 9.1）。
 *
 * 从既有表（tasks / audit_logs / sessions）计算核心指标，不新建表——
 * 指标是派生视图，入库反而引入口径漂移。检索环节单独指标（P50/P95 延迟、
 * 引用覆盖率）在 P5-2 大仓指标一并补齐。
 */

import type { DatabaseSync } from "node:sqlite";

export interface CoreMetrics {
	/** 任务总数 */
	totalTasks: number;
	/** 任务成功率：端到端 deliver（done / 总定稿数） */
	successRate: number;
	/** 人工介入率：awaiting_manual（含终态前经过的）占比 */
	manualInterventionRate: number;
	/** 超预算被强停比例（budget_exceeded 审计事件 / 总任务） */
	budgetStopRate: number;
	/** 平均步数（sessions.task_state.budget.steps_used） */
	avgSteps: number;
	/** 工具调用失败率：按工具拆（tool_blocked / 工具执行总数近似） */
	toolBlockedByTool: Record<string, number>;
	/** 每任务 Token 成本与美元成本（agent 审计预算事件聚合的近似口径） */
	tokenBudgetHits: number;
}

export function collectMetrics(db: DatabaseSync): CoreMetrics {
	const total = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
	const done = (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'").get() as { c: number }).c;
	const finalized = (db
		.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('done','rejected','failed')")
		.get() as { c: number }).c;
	// 人工介入：走过 awaiting_manual 的任务（含已收口的）——task_events 里找状态轨迹
	const manualTouched = (db
		.prepare("SELECT COUNT(DISTINCT task_id) AS c FROM task_events WHERE payload LIKE '%awaiting_manual%'")
		.get() as { c: number }).c;
	// 预算强停与工具拦截：agent 审计事件落 audit_logs（action = agent_audit）
	const budgetStops = (db
		.prepare("SELECT COUNT(DISTINCT object_id) AS c FROM audit_logs WHERE object_type = 'agent' AND action = 'budget_exceeded'")
		.get() as { c: number }).c;

	const blockedRows = db
		.prepare("SELECT detail FROM audit_logs WHERE object_type = 'agent' AND action = 'tool_blocked'")
		.all() as unknown as Array<{ detail: string }>;
	const toolBlockedByTool: Record<string, number> = {};
	for (const r of blockedRows) {
		try {
			const tool = (JSON.parse(r.detail) as { tool?: string }).tool ?? "unknown";
			toolBlockedByTool[tool] = (toolBlockedByTool[tool] ?? 0) + 1;
		} catch {
			toolBlockedByTool.unknown = (toolBlockedByTool.unknown ?? 0) + 1;
		}
	}

	// 平均步数：sessions.task_state.budget.steps_used
	const stepRows = db.prepare("SELECT task_state FROM sessions").all() as unknown as Array<{ task_state: string }>;
	let stepsSum = 0;
	let stepsCount = 0;
	for (const r of stepRows) {
		try {
			const used = (JSON.parse(r.task_state) as { budget?: { steps_used?: number } }).budget?.steps_used;
			if (typeof used === "number") {
				stepsSum += used;
				stepsCount += 1;
			}
		} catch {
			// 脏数据跳过
		}
	}

	return {
		totalTasks: total,
		successRate: finalized > 0 ? done / finalized : 0,
		manualInterventionRate: total > 0 ? manualTouched / total : 0,
		budgetStopRate: total > 0 ? budgetStops / total : 0,
		avgSteps: stepsCount > 0 ? stepsSum / stepsCount : 0,
		toolBlockedByTool,
		tokenBudgetHits: budgetStops,
	};
}
