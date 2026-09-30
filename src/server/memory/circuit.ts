/**
 * 记忆检索侧断路器（移植 fiat-agent-pi memory/circuit.ts，P15-106 同款）。
 *
 * 形状对齐 hermes `memory_manager.py`：threshold=5 / cooldown=120s。
 * 没有熔断器的「降级」是名存实亡的 —— 返回了空结果，但每次先撞 30s 超时。
 *
 * 三个与 fiat 版一致的关键语义：
 * 1. 只统计「连续」失败，成功一次即归零；
 * 2. 冷却期满不预置 closed，而是放行一次探测，结果决定去向；
 * 3. 时钟注入（now），测试不用 sleep。
 */

export type CircuitState = "closed" | "open";

export interface CircuitBreakerOptions {
	/** 连续失败多少次后打开。缺省 5 */
	threshold?: number;
	/** 冷却期 ms。缺省 120_000 */
	cooldownMs?: number;
	/** 时钟注入（测试用）；缺省 `Date.now` */
	now?: () => number;
}

export interface CircuitSnapshot {
	state: CircuitState;
	consecutiveFailures: number;
	remainingCooldownMs: number;
	shortCircuited: number;
	openedCount: number;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 120_000;

export class MemoryCircuitBreaker {
	private readonly threshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;

	private state: CircuitState = "closed";
	private failures = 0;
	private openedAt = 0;
	private probing = false;
	private shortCircuited = 0;
	private openedCount = 0;

	constructor(opts: CircuitBreakerOptions = {}) {
		this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
		this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = opts.now ?? Date.now;
	}

	/** 现在该不该真的发请求？`false` = 直接降级，不要去撞超时 */
	allow(): boolean {
		if (this.state === "closed") return true;
		if (this.now() - this.openedAt >= this.cooldownMs) {
			this.probing = true; // 冷却期满：本次是探测，不是恢复
			return true;
		}
		this.shortCircuited += 1;
		return false;
	}

	/** 一次成功：连续失败归零，状态回到 closed */
	recordSuccess(): void {
		this.failures = 0;
		if (this.state === "open") {
			this.state = "closed";
			this.probing = false;
		}
	}

	/** 一次失败（超时 / 网络错误 / 对端 degraded=true） */
	recordFailure(): void {
		this.failures += 1;
		if (this.failures < this.threshold) return;
		const wasClosed = this.state === "closed";
		const wasProbing = this.probing;
		this.probing = false;
		this.openedAt = this.now();
		this.state = "open";
		// 冷却期内的重复失败不换窗口；探测失败状态未变，不重复计数
		if (!wasClosed && !wasProbing) return;
		this.openedCount += 1;
	}

	snapshot(): CircuitSnapshot {
		const remaining = this.state === "open" ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0;
		return {
			state: this.state,
			consecutiveFailures: this.failures,
			remainingCooldownMs: remaining,
			shortCircuited: this.shortCircuited,
			openedCount: this.openedCount,
		};
	}
}
