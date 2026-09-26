/**
 * Harness 任务编排层（技术方案 · 一/七/八 的粘合层）
 *
 * 职责：消费归一化事件 → 校验/权限/路由 → 建 VulcanTask → 派发给对应链路。
 * 口径：确定的流程交给程序，需要探索的步骤交给 Agent，不确定的决策交给人。
 */

import type { EventQueue } from "../gateway/queue.ts";
import type { InternalEvent, VulcanTask } from "../types.ts";

export interface HarnessDeps {
	queue: EventQueue;
}

export class Harness {
	readonly #deps: HarnessDeps;
	readonly #tasks = new Map<string, VulcanTask>();
	#timer?: NodeJS.Timeout;

	constructor(deps: HarnessDeps) {
		this.#deps = deps;
	}

	start(pollMs = 500): void {
		this.#timer = setInterval(() => void this.poll(), pollMs);
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
	}

	async poll(): Promise<void> {
		for (const event of this.#deps.queue.drain()) {
			try {
				this.route(event);
			} catch (err) {
				this.#deps.queue.deadLetter(event, String(err));
			}
		}
	}

	/** 按事件来源路由到三条链路之一（链路实现后续填充） */
	route(event: InternalEvent): VulcanTask {
		const task: VulcanTask = {
			id: `task:${event.id}`,
			source: event.source,
			ref: event.ref,
			status: "received",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.#tasks.set(task.id, task);
		switch (event.source) {
			case "alert":
				// TODO: AlertHandler —— 去重降噪 / 分级 / 关联工单 / 触发修复链路
				break;
			case "meegle":
				// TODO: MeegleService —— Open API 回查详情 → 任务整理 → 修复链路
				break;
			case "approval":
				// TODO: ApprovalService —— 策略裁决 → 通过 / 驳回 / 转人工
				break;
		}
		return task;
	}

	get(taskId: string): VulcanTask | undefined {
		return this.#tasks.get(taskId);
	}
}
