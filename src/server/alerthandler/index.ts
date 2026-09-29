/**
 * 告警处理（DEV_SPEC §14 P2-1/P2-2，技术方案 7.1）。
 *
 * 职责边界：
 *   - 去重降噪：同 group（service + 标题特征）在抑制窗口内合并，只保留首条
 *   - 分级：severity（critical/high/medium/low）+ 责任团队与仓库匹配（路由表）
 *   - 自动修复白名单：命中的服务+级别直接进修复链路；白名单外只产出分析建议并回写
 *
 * 确定性边界：分级/合并/白名单判定全部是规则代码，不经过模型。
 */

import type { InternalEvent, AlertSeverity } from "../types.ts";

export interface AlertRouting {
	/** 告警标签/服务名 → 责任团队 */
	team: string;
	/** 责任团队 → 默认代码仓库 */
	repo: string;
}

export interface RoutingTable {
	/** 匹配规则按序生效：labels 匹配 service（精确）→ 团队+仓库 */
	entries: Array<{ service: string; team: string; repo: string }>;
	/** 兜底：未匹配时 */
	defaultTeam: string;
	defaultRepo: string;
}

export interface AlertDecision {
	groupKey: string;
	severity: AlertSeverity;
	team: string;
	repo: string;
	/** true = 白名单命中，走自动修复；false = 只出分析建议 */
	autofix: boolean;
	/** true = 命中抑制窗口，本条被合并（不新建任务） */
	suppressed: boolean;
}

export interface AlertHandlerDeps {
	/** 自动修复白名单：service → 允许自动修复的最高 severity（含） */
	autofixAllowlist: Record<string, AlertSeverity[]>;
	/** 同 group 抑制窗口 ms，默认 5 分钟 */
	suppressWindowMs?: number;
	routing: RoutingTable;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** group key：同服务+同标题视为同组（方案 7.1「同 group 告警合并」） */
export function groupKeyOf(event: InternalEvent): string {
	const svc = String(event.payload.service ?? "unknown");
	const title = String(event.payload.title ?? "unknown");
	return `${svc}::${title}`;
}

export class AlertHandler {
	/** groupKey → 上次放行时间 ms（进程内降噪窗口；跨重启以 DB 任务是否存在为准） */
	private readonly lastFired = new Map<string, number>();
	private readonly deps: AlertHandlerDeps;

	constructor(deps: AlertHandlerDeps) {
		this.deps = deps;
	}

	route(event: InternalEvent): AlertDecision {
		const service = String(event.payload.service ?? "unknown");
		const severity = (event.payload.severity as AlertSeverity) ?? "low";
		const groupKey = groupKeyOf(event);

		// 去重降噪：抑制窗口内的同组告警合并
		const now = Date.now();
		const last = this.lastFired.get(groupKey);
		const window = this.deps.suppressWindowMs ?? 5 * 60_000;
		const suppressed = last !== undefined && now - last < window;
		if (!suppressed) this.lastFired.set(groupKey, now);

		// 责任团队与仓库匹配（精确 service 匹配 → 兜底）
		const entry = this.deps.routing.entries.find((e) => e.service === service);
		const team = entry?.team ?? this.deps.routing.defaultTeam;
		const repo = entry?.repo ?? this.deps.routing.defaultRepo;

		// 自动修复白名单：severity 必须达到该服务允许清单中某一级（更严重或同级）
		const allowed = this.deps.autofixAllowlist[service];
		const autofix =
			Array.isArray(allowed) && allowed.some((s) => SEVERITY_ORDER[severity] <= SEVERITY_ORDER[s]);

		return { groupKey, severity, team, repo, autofix, suppressed };
	}
}
