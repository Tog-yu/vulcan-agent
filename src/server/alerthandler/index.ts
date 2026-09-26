/**
 * 告警处理（技术方案 · 7.1）
 *
 * 链路：去重降噪（同 group 合并/抑制）→ 分级 → 匹配责任团队与仓库 → 关联/建 meegle 工单 → 触发修复链路。
 * 安全口径：生产级 / 高风险告警默认只给分析建议，需人工确认，不直接进自动修复。
 */

import type { InternalEvent } from "../types.ts";

export interface AlertHandlerDeps {
	/** 允许无人值守自动修复的服务白名单（按服务名），未命中只出分析建议 */
	autoFixWhitelist: Set<string>;
}

export interface AlertOutcome {
	action: "auto_fix" | "advise_only" | "merged";
	reason: string;
}

export class AlertHandler {
	readonly #deps: AlertHandlerDeps;
	/** 同 fingerprint 的活跃告警，用于合并抑制 */
	readonly #active = new Map<string, number>();

	constructor(deps: AlertHandlerDeps) {
		this.#deps = deps;
	}

	handle(event: InternalEvent): AlertOutcome {
		const fp = String(event.payload.fingerprint ?? event.ref);
		const severity = String(event.payload.severity ?? "medium");
		const service = String(event.payload.service ?? "unknown");

		// 去重降噪：窗口内同 fingerprint 合并
		const lastSeen = this.#active.get(fp);
		const now = Date.now();
		if (lastSeen && now - lastSeen < 60_000) {
			this.#active.set(fp, now);
			return { action: "merged", reason: "60s 窗口内重复告警，已合并" };
		}
		this.#active.set(fp, now);

		// 自动修复白名单：未命中只给建议（生产 / 高风险默认人工确认）
		if (severity === "critical" || severity === "high" || !this.#deps.autoFixWhitelist.has(service)) {
			return {
				action: "advise_only",
				reason: `服务 ${service} 不在自动修复白名单或级别为 ${severity}，仅输出分析建议`,
			};
		}
		return { action: "auto_fix", reason: "命中白名单，触发修复链路" };
	}
}
