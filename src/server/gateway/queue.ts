/**
 * 持久化队列 + 重试 + 死信（DEV_SPEC §14 P1-6，模块卡见 §6「异步与事件」）。
 *
 * 机制：
 *   - 事件落地 webhook_events 表（status: queued → processing → done / dead）
 *   - 消费失败重试 retry.maxAttempts 次（含首次），耗尽进死信（dead）并触发 onError 回调（P1 告警挂点）
 *   - 幂等：主键冲突返回 false，重复投递不重复入队
 *   - 崩溃恢复：recoverInterrupted() 把遗留的 processing 重置为 queued，重启后重放（at-least-once）
 *   - 单实例单消费循环（DEV_SPEC §7 并发与一致性）
 */

import type { DatabaseSync } from "node:sqlite";
import type { InternalEvent } from "../types.ts";

export interface QueueOptions {
	maxAttempts: number;
	onError?: (event: InternalEvent, err: Error, attempts: number) => void;
	onDead?: (event: InternalEvent, err: Error) => void;
	/** 重试退避基数 ms（n 次 → base * 2^(n-1)），默认 100 */
	retryBaseMs?: number;
}

interface StoredEvent {
	id: string;
	source: InternalEvent["source"];
	type: string;
	occurredAt: number;
	ref: string;
	payload: string;
	raw: string;
	attempts: number;
}

export class EventQueue {
	private readonly db: DatabaseSync;
	private readonly opts: QueueOptions;

	constructor(db: DatabaseSync, opts: QueueOptions) {
		this.db = db;
		this.opts = opts;
	}

	/** 幂等入队：同 ID 首次返回 true，重复返回 false（不抛错、不重复副作用） */
	tryEnqueue(event: InternalEvent): boolean {
		try {
			this.db
				.prepare(
					`INSERT INTO webhook_events (id, source, type, occurred_at, ref, payload, raw, received_at, status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
				)
				.run(
					event.id,
					event.source,
					event.type,
					event.occurredAt,
					event.ref,
					JSON.stringify(event.payload),
					JSON.stringify(event.raw ?? null),
					Date.now(),
				);
			return true;
		} catch (err) {
			if (String((err as Error).message).includes("UNIQUE constraint failed")) {
				return false;
			}
			throw err;
		}
	}

	/** 取一条待处理事件（FIFO：received_at 升序），标记 processing；无则 null */
	private claimNext(): StoredEvent | null {
		const row = this.db
			.prepare(
				`SELECT id, source, type, occurred_at, ref, payload, raw, 0 AS attempts
				 FROM webhook_events WHERE status = 'queued' ORDER BY received_at ASC LIMIT 1`,
			)
			.get() as StoredEvent | undefined;
		if (!row) return null;
		const claimed = this.db
			.prepare("UPDATE webhook_events SET status = 'processing' WHERE id = ? AND status = 'queued'")
			.run(row.id);
		if (Number(claimed.changes) === 0) return null; // 并发抢占失败，下一轮再取
		return row;
	}

	private getAttempts(id: string): number {
		const r = this.db.prepare("SELECT attempts FROM webhook_events WHERE id = ?").get(id) as
			| { attempts?: number }
			| undefined;
		return Number(r?.attempts ?? 0) + 1;
	}

	private setAttempts(id: string, attempts: number): void {
		this.db.prepare("UPDATE webhook_events SET attempts = ? WHERE id = ?").run(attempts, id);
	}

	private toEvent(row: StoredEvent): InternalEvent {
		return {
			id: row.id,
			source: row.source,
			type: row.type,
			occurredAt: row.occurredAt,
			ref: row.ref,
			payload: JSON.parse(row.payload) as Record<string, unknown>,
			raw: JSON.parse(row.raw),
		};
	}

	/**
	 * 消费循环：逐条处理，失败按退避重试，耗尽进死信。
	 * idle 回调返回 true 时继续轮询（外部控制停止）。
	 */
	async run(handler: (event: InternalEvent) => Promise<void>, shouldContinue: () => boolean): Promise<void> {
		const base = this.opts.retryBaseMs ?? 100;
		while (shouldContinue()) {
			const row = this.claimNext();
			if (!row) {
				await new Promise((r) => setTimeout(r, 50));
				continue;
			}
			const event = this.toEvent(row);
			let lastErr: Error | null = null;
			const attempts = this.getAttempts(row.id);
			for (let attempt = attempts; attempt <= this.opts.maxAttempts; attempt++) {
				this.setAttempts(row.id, attempt);
				try {
					await handler(event);
					this.db.prepare("UPDATE webhook_events SET status = 'done' WHERE id = ?").run(row.id);
					lastErr = null;
					break;
				} catch (err) {
					lastErr = err as Error;
					this.opts.onError?.(event, lastErr, attempt);
					if (attempt < this.opts.maxAttempts) {
						await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
					}
				}
			}
			if (lastErr) {
				this.db.prepare("UPDATE webhook_events SET status = 'dead' WHERE id = ?").run(row.id);
				this.opts.onDead?.(event, lastErr);
			}
		}
	}

	/**
	 * 崩溃恢复：把遗留 processing 重置回 queued（at-least-once，幂等键保证不重复执行副作用）。
	 * 返回重置条数。
	 */
	recoverInterrupted(): number {
		const r = this.db
			.prepare("UPDATE webhook_events SET status = 'queued' WHERE status = 'processing'")
			.run();
		return Number(r.changes);
	}

	deadCount(): number {
		const r = this.db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'dead'").get() as {
			n: number;
		};
		return Number(r.n);
	}
}
