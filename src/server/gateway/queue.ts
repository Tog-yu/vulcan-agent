/**
 * 事件队列 —— 框架阶段用内存实现 + 死信占位。
 * 后续替换为持久化队列（SQLite / Redis），接口不变。
 */

import type { InternalEvent } from "../types.ts";

export interface QueueStats {
	enqueued: number;
	duplicates: number;
	deadLetters: number;
}

export class EventQueue {
	readonly #seen = new Set<string>();
	readonly #pending: InternalEvent[] = [];
	readonly #deadLetters: InternalEvent[] = [];
	#stats: QueueStats = { enqueued: 0, duplicates: 0, deadLetters: 0 };

	/** 入队；返回 false 表示重复事件（幂等去重） */
	enqueue(event: InternalEvent): boolean {
		if (this.#seen.has(event.id)) {
			this.#stats.duplicates++;
			return false;
		}
		this.#seen.add(event.id);
		this.#pending.push(event);
		this.#stats.enqueued++;
		return true;
	}

	drain(): InternalEvent[] {
		return this.#pending.splice(0);
	}

	deadLetter(event: InternalEvent, reason: string): void {
		this.#stats.deadLetters++;
		this.#deadLetters.push(event);
		console.error(`[queue] dead letter ${event.id}: ${reason}`);
	}

	stats(): QueueStats {
		return { ...this.#stats };
	}
}
