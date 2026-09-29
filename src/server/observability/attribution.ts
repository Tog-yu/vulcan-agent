/**
 * 失败归因（DEV_SPEC §14 P4-5，技术方案 9.3）。
 *
 * 基于 trace/审计事件把失败自动归类为九类之一，形成可统计、可对比的归因分布：
 *   路由错误 / 槽位丢失 / 错误工具参数 / RAG 无命中 / 无效循环 /
 *   上下文污染 / 过早结束 / 权限越界 / 模型异常
 *
 * 归因规则是确定性代码（§10：不由模型兜），输入 = 任务审计事件轨迹 + 任务终态。
 */

import type { DatabaseSync } from "node:sqlite";

export const FAILURE_CATEGORIES = [
	"route_error",
	"slot_missing",
	"wrong_tool_or_args",
	"rag_no_hit",
	"invalid_loop",
	"context_pollution",
	"premature_stop",
	"permission_violation",
	"model_error",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface AuditEvent {
	kind: string;
	detail: Record<string, unknown>;
}

export interface Attribution {
	category: FailureCategory;
	/** 判定依据（可解释性：归因必须能说出证据） */
	evidence: string;
}

/**
 * 单任务归因。按证据优先级从强到弱判定：
 *   tool_blocked 审计在案 → permission_violation（最强证据：拦截是确定性事实）
 *   budget_exceeded(steps) + 大量重复同参工具调用 → invalid_loop
 *   budget_exceeded(其他维度) → invalid_loop（预算强停通常是打转/膨胀）
 *   task failed 且无工具产出（没调过任何工具就退） → premature_stop
 *   其余 failed → model_error（排除法兜底）
 */
export function attributeFailure(events: AuditEvent[], taskStatus: string): Attribution | null {
	if (!["failed", "rejected"].includes(taskStatus)) return null;

	const blocked = events.find((e) => e.kind === "tool_blocked");
	if (blocked) {
		return {
			category: "permission_violation",
			evidence: `工具 ${(blocked.detail.tool as string) ?? "?"} 被白名单拦截：${String(blocked.detail.reason ?? "")}`,
		};
	}

	const budget = events.find((e) => e.kind === "budget_exceeded");
	if (budget) {
		// 步数超限 + 同名工具反复调用 = 无效循环的直接证据
		const toolCalls = events.filter((e) => e.kind === "tool_call");
		const byTool = new Map<string, number>();
		for (const e of toolCalls) byTool.set(String(e.detail.tool), (byTool.get(String(e.detail.tool)) ?? 0) + 1);
		const repeated = [...byTool.entries()].some(([, n]) => n >= 3);
		if (budget.detail.dimension === "steps" && repeated) {
			const [tool, n] = [...byTool.entries()].sort((a, b) => b[1] - a[1])[0];
			return { category: "invalid_loop", evidence: `步数超限且 ${tool} 重复调用 ${n} 次` };
		}
		return { category: "invalid_loop", evidence: `预算超限（${String(budget.detail.dimension)}），任务被强停` };
	}

	const toolCalls = events.filter((e) => e.kind === "tool_call");
	if (toolCalls.length === 0) {
		return { category: "premature_stop", evidence: "全程未调用任何工具即结束（未进入定位/修改阶段）" };
	}

	return { category: "model_error", evidence: "有工具调用但执行失败，排除法归为模型异常" };
}

/** 批量归因：全量 failed/rejected 任务的归因分布 */
export function attributionDistribution(db: DatabaseSync): Record<FailureCategory, number> {
	const dist = Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, 0])) as Record<FailureCategory, number>;
	const rows = db
		.prepare("SELECT id, status FROM tasks WHERE status IN ('failed','rejected')")
		.all() as unknown as Array<{ id: string; status: string }>;
	for (const row of rows) {
		const events = db
			.prepare("SELECT action, detail FROM audit_logs WHERE object_type = 'agent' AND object_id = ?")
			.all(row.id) as unknown as Array<{ action: string; detail: string }>;
		const parsed: AuditEvent[] = events.map((e) => {
			let detail: Record<string, unknown> = {};
			try {
				detail = JSON.parse(e.detail) as Record<string, unknown>;
			} catch {
				// 容忍脏 detail
			}
			return { kind: e.action, detail };
		});
		const attribution = attributeFailure(parsed, row.status);
		if (attribution) dist[attribution.category] += 1;
	}
	return dist;
}
