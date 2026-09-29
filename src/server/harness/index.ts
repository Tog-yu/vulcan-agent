/**
 * Harness 任务编排层（DEV_SPEC §14 P1-7）。
 *
 * 职责边界：
 *   - 从队列消费 InternalEvent → 按 source 路由到对应 handler → 建/更新 VulcanTask
 *   - 状态流转全部走确定性流转表（state-machine.ts），非法流转抛错并告警
 *   - 确定的流程交给程序，需要探索的步骤交给 Agent，不确定的决策交给人
 */

import type { DatabaseSync } from "node:sqlite";
import type { InternalEvent } from "../types.ts";
import { transitionTask, canTransition, IllegalTransitionError } from "./state-machine.ts";
import type { TaskStatus } from "../types.ts";

export type RouteHandler = (event: InternalEvent, taskId: string) => Promise<void>;

export interface HarnessDeps {
	db: DatabaseSync;
	/** 三来源业务 handler（P2 起由 alerthandler/meegle/approval 实现） */
	routes: Partial<Record<InternalEvent["source"], RouteHandler>>;
	/** 告警挂点：非法流转等编排异常 */
	onWarn?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class Harness {
	private readonly deps: HarnessDeps;

	constructor(deps: HarnessDeps) {
		this.deps = deps;
	}

	/** 幂等建任务：同 (source, ref) 已存在任务则复用，不重复建（P2-2 关联语义的前置） */
	getOrCreateTask(event: InternalEvent): { taskId: string; created: boolean } {
		const existing = this.deps.db
			.prepare("SELECT id FROM tasks WHERE source = ? AND ref = ? ORDER BY created_at DESC LIMIT 1")
			.get(event.source, event.ref) as { id: string } | undefined;
		if (existing) return { taskId: existing.id, created: false };

		const id = `task-${event.source}-${event.ref}-${Date.now()}`;
		const now = Date.now();
		this.deps.db
			.prepare(
				"INSERT INTO tasks (id, source, ref, status, created_at, updated_at) VALUES (?, ?, ?, 'received', ?, ?)",
			)
			.run(id, event.source, event.ref, now, now);
		return { taskId: id, created: true };
	}

	/** 处理一条事件：路由 + 状态推进（received → triaged → running 由对应链路推进） */
	async handleEvent(event: InternalEvent): Promise<string> {
		const { taskId } = this.getOrCreateTask(event);
		const handler = this.deps.routes[event.source];
		if (handler) {
			await handler(event, taskId);
		}
		return taskId;
	}

	/** 确定性流转封装：非法流转记录告警并抛错（DEV_SPEC §14 P1-7 验收） */
	transition(taskId: string, from: TaskStatus, to: TaskStatus): void {
		if (!canTransition(from, to)) {
			const err = new IllegalTransitionError(taskId, from, to);
			this.deps.onWarn?.("非法状态流转被拒绝", { taskId, from, to });
			throw err;
		}
		const ok = transitionTask(this.deps.db, taskId, from, to);
		if (!ok) {
			// 前态不符：并发修改或状态已变，按非法流转处理
			const err = new IllegalTransitionError(taskId, from, to);
			this.deps.onWarn?.("状态前置条件不满足，流转拒绝", { taskId, from, to });
			throw err;
		}
	}
}
