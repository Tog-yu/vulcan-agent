/**
 * 任务定稿离线提炼（DEV_SPEC §14 P4-3，技术方案 6.2）——RAG 后端版。
 *
 * 不在线上实时写。任务结束（done/rejected/failed）后，从
 * task_state + 补丁引用 + 测试记录 + 失败归因中挑出候选，
 * 逐条按 6.3 准入标准（MemoryGate）校验后，经 MemoryStore（RAG 桥）入库。
 * 失败任务的提炼尤其重要——"有证据的失败经验"的主要来源（6.5）。
 *
 * 注意：tasks / sessions / approvals 仍是本地 SQLite（任务事实数据）；
 * 只有**记忆正文**走 RAG。两个存储的边界在这里体现。
 */

import type { DatabaseSync } from "node:sqlite";
import type { MemoryCandidate } from "./gate.ts";
import { MemoryGate } from "./gate.ts";
import type { AdmitResult, MemoryStore } from "./index.ts";

export interface DistillResult {
	candidates: number;
	admitted: number;
	denied: number;
	results: AdmitResult[];
}

/** 从 sessions.task_state 与审批/测试痕迹生成候选（确定性规则，不由模型自由发挥） */
export async function distillFromTask(
	db: DatabaseSync,
	taskId: string,
	project: string,
	store: MemoryStore,
): Promise<DistillResult> {
	const task = db.prepare("SELECT id, status, ref FROM tasks WHERE id = ?").get(taskId) as
		| { id: string; status: string; ref: string }
		| undefined;
	if (!task) return { candidates: 0, admitted: 0, denied: 0, results: [{ admitted: false, reason: "task-not-found" }] };

	// 只在定稿态提炼（中间态的提炼属于 6.3 排除清单："当前任务的中间态"）
	if (!["done", "rejected", "failed"].includes(task.status)) {
		return { candidates: 0, admitted: 0, denied: 0, results: [{ admitted: false, reason: "task-not-finalized" }] };
	}

	const sess = db.prepare("SELECT task_state FROM sessions WHERE task_id = ?").get(taskId) as
		| { task_state: string }
		| undefined;
	const state = sess
		? (JSON.parse(sess.task_state) as { context?: Record<string, unknown>; budget?: Record<string, unknown> })
		: {};
	const approval = db
		.prepare("SELECT decision, reason FROM approvals WHERE id = ? ORDER BY decided_at DESC LIMIT 1")
		.get(`AP-${taskId}`) as { decision: string; reason: string } | undefined;

	const candidates: MemoryCandidate[] = [];
	const source = `task:${taskId}`;
	const codeVersion = (state.context?.base_commit as string) ?? undefined;

	// ① 通过审批的修复 → verified_by_test 的修复案例
	if (task.status === "done" && approval?.decision === "approved") {
		candidates.push({
			content: `任务 ${taskId}（${task.ref}）的修复通过自动审批：${approval.reason}`,
			category: "verified_fix",
			source,
			project,
			codeVersion,
			verificationStatus: "verified_by_test",
		});
	}

	// ② 禁止项驳回 → 项目约束（被审批策略确认过 → verified_by_human 语义：策略规则即人工决策的固化）
	if (approval?.decision === "rejected") {
		candidates.push({
			content: `任务 ${taskId}（${task.ref}）被审批禁止项驳回：${approval.reason}。后续同类变更需预先规避。`,
			category: "constraint_decision",
			source,
			project,
			codeVersion,
			verificationStatus: "verified_by_human",
		});
	}

	// ③ 执行失败 → 有证据的失败经验（evidence = 状态机到达 failed 的确定性事实）
	if (task.status === "failed") {
		candidates.push({
			content: `任务 ${taskId}（${task.ref}）执行失败。失败上下文：预算 ${JSON.stringify(state.budget ?? {})}。该路径在此条件下走不通。`,
			category: "failure_lesson",
			source,
			project,
			codeVersion,
			verificationStatus: "observed",
		});
	}

	// 逐条过门禁 + RAG 写入（顺序写，一条失败不影响其余）
	const results: AdmitResult[] = [];
	for (const c of candidates) {
		results.push(await store.admit(c));
	}
	return {
		candidates: candidates.length,
		admitted: results.filter((r) => r.admitted).length,
		denied: results.filter((r) => !r.admitted).length,
		results,
	};
}

/** 保留导出以兼容既有引用面（MemoryGate.check 的静态校验入口） */
export { MemoryGate };
