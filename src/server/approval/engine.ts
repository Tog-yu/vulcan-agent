/**
 * 审批策略引擎 + 三态裁决（DEV_SPEC §14 P2-5，技术方案 8.2）。
 *
 * 硬约束（DEV_SPEC §10）：
 *   - 裁决由确定性策略代码实现，不由模型+提示词兜住
 *   - 命中禁止项 → 直接 rejected，不降级为 manual
 *   - 整体从严：策略未配置 = 全部转人工；策略引擎抛错 → manual（不放行）
 *   - 自动通过要求：无禁止项 + 全部 allow 规则满足 + 验证证据完整
 *
 * 五输入裁决：变更意图 / 变更内容 / 验证证据 / 策略规则 / 历史同类审批。
 */

import type { ApprovalRequest, ApprovalDecision } from "../types.ts";

export interface DenyRule {
	/** 禁止项 ID，如 prod-config / data-migration / cross-repo / huge-diff / no-evidence */
	id: string;
	test: (req: ApprovalRequest) => boolean;
	reason: string;
}

export interface AllowRule {
	id: string;
	test: (req: ApprovalRequest) => boolean;
	/** 不满足时的说明（转人工理由） */
	why: string;
}

export interface PolicyConfig {
	allow: AllowRule[];
	/** 禁止项是全局固定清单 + 按项目可追加 */
	deny: DenyRule[];
}

/** 全局禁止项（技术方案 8.2：生产配置/数据迁移/跨仓/超大 diff/无验证证据），命中直接驳回 */
export const BUILTIN_DENY_RULES: DenyRule[] = [
	{ id: "prod-config", test: (r) => /(^|\/)(prod|production)(\/|\.)/i.test(r.changedFiles.join(",")) || /production/i.test(r.impactScope), reason: "涉及生产配置，禁止自动放行" },
	{ id: "data-migration", test: (r) => r.changedFiles.some((f) => /migration|migrate/i.test(f)), reason: "涉及数据迁移，禁止自动放行" },
	{ id: "cross-repo", test: (r) => new Set(r.changedFiles.map((f) => f.split("/")[0])).size > 1, reason: "跨仓库变更，禁止自动放行" },
	{ id: "huge-diff", test: (r) => r.changedFiles.length > 50 || r.diffSummary.length > 100_000, reason: "超大 diff，禁止自动放行" },
	{ id: "no-evidence", test: (r) => !r.evidence.buildPassed || !r.evidence.testsPassed || r.evidence.commands.length === 0, reason: "验证证据不完整（构建/测试未全过或无命令记录），禁止自动放行" },
];

/** 默认从严策略：无 allow 规则 = 永远不可能自动通过 → 全部转人工 */
export const DEFAULT_POLICY: PolicyConfig = {
	allow: [],
	deny: BUILTIN_DENY_RULES,
};

export interface Adjudication {
	decision: ApprovalDecision;
	/** 命中的禁止项 / 未满足的 allow 规则说明 */
	reasons: string[];
	matchedDeny: string[];
	matchedAllowUnmet: string[];
	/** 历史同类审批参考（P4-2 记忆召回接入前的占位输入） */
	historyNote?: string;
}

export class ApprovalEngine {
	private readonly policy: PolicyConfig;

	constructor(policy: PolicyConfig = DEFAULT_POLICY) {
		this.policy = policy;
	}

	/**
	 * 三态裁决（从严顺序）：
	 *   1. 任一禁止项命中 → rejected（不再看 allow，不降级）
	 *   2. allow 规则全满足且证据完整 → approved
	 *   3. 其余（规则未覆盖/不满足）→ manual
	 * 策略引擎自身抛错 → manual（从严兜底，绝不放行）。
	 */
	decide(req: ApprovalRequest, historyNote?: string): Adjudication {
		try {
			const matchedDeny: string[] = [];
			for (const rule of this.policy.deny) {
				if (rule.test(req)) matchedDeny.push(rule.id);
			}
			if (matchedDeny.length > 0) {
				return {
					decision: "rejected",
					reasons: this.policy.deny.filter((r) => matchedDeny.includes(r.id)).map((r) => r.reason),
					matchedDeny,
					matchedAllowUnmet: [],
					historyNote,
				};
			}

			const unmet: string[] = [];
			for (const rule of this.policy.allow) {
				if (!rule.test(req)) unmet.push(rule.why);
			}
			if (unmet.length === 0 && this.policy.allow.length > 0) {
				return { decision: "approved", reasons: ["全部 allow 规则满足且验证证据完整"], matchedDeny: [], matchedAllowUnmet: [], historyNote };
			}
			return {
				decision: "manual",
				reasons: unmet.length > 0 ? unmet : ["无 allow 规则覆盖该变更类型（从严：转人工）"],
				matchedDeny: [],
				matchedAllowUnmet: unmet,
				historyNote,
			};
		} catch (err) {
			return {
				decision: "manual",
				reasons: [`策略引擎异常，从严转人工：${(err as Error).message}`],
				matchedDeny: [],
				matchedAllowUnmet: ["policy-engine-error"],
			};
		}
	}
}
