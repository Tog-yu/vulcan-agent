/**
 * 任务状态机（DEV_SPEC §5，状态枚举对齐 src/server/types.ts:84-92）。
 *
 * 硬约束（DEV_SPEC §10）：状态流转必须由确定性流转表实现，非法流转一律拒绝——
 * 不由"模型 + 提示词"兜住。流转用 UPDATE ... WHERE status = <期望前态> 的前置条件校验。
 */

import type { TaskStatus } from "../types.ts";

/** 允许的流转：key = 前态，value = 可达后态集合（对齐 DEV_SPEC §5 状态机图） */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	received: ["triaged"],
	triaged: ["running"],
	running: ["awaiting_approval", "failed"],
	awaiting_approval: ["running", "done", "rejected", "awaiting_manual"],
	awaiting_manual: ["done", "rejected", "failed"],
	done: [],
	failed: [],
	rejected: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
	readonly taskId: string;
	readonly from: TaskStatus;
	readonly to: TaskStatus;

	constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
		super(`非法状态流转：任务 ${taskId} ${from} → ${to}`);
		this.taskId = taskId;
		this.from = from;
		this.to = to;
	}
}

/**
 * 数据库内前置条件流转：UPDATE ... WHERE status = <前态>。
 * 返回 true = 流转成功；false = 前态已被并发修改（非法流转场景由调用方先 canTransition 校验）。
 * 非法流转（canTransition 为 false）直接抛 IllegalTransitionError，由编排层告警。
 */
export function transitionTask(
	db: import("node:sqlite").DatabaseSync,
	taskId: string,
	from: TaskStatus,
	to: TaskStatus,
): boolean {
	if (!canTransition(from, to)) {
		throw new IllegalTransitionError(taskId, from, to);
	}
	const r = db
		.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
		.run(to, Date.now(), taskId, from);
	return Number(r.changes) === 1;
}
