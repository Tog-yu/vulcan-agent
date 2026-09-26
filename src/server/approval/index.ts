/**
 * 审批裁决（技术方案 · 八）
 *
 * 输入来自修复链路产出（变更意图 / diff / 影响范围 / 验证证据 / 策略规则 / 历史同类审批）。
 * 输出三态：approved / rejected / manual。
 * 硬约束：命中禁止项直接驳回，不降级为人工；整体从严，宁可转人工不放宽策略。
 */

import type { NotifyService } from "../notify/index.ts";
import type { ApprovalDecision, ApprovalRequest } from "../types.ts";

// ---------- 策略 ----------

export interface ApprovalPolicy {
	/** 允许自动通过的规则（全部满足才自动通过） */
	allow: {
		maxChangedFiles: number;
		requireAllTestsPassed: boolean;
		/** 仅允许这些路径前缀下的变更（如 ["src/", "test/"]） */
		allowedPathPrefixes: string[];
	};
	/** 禁止项：命中即驳回（不转人工） */
	deny: {
		pathPrefixes: string[]; // 如 ["config/prod/", "infra/", "db/migration/"]
		keywords: string[]; // diff 中出现即驳回，如 ["DROP TABLE", "production"]
	};
}

export const DEFAULT_POLICY: ApprovalPolicy = {
	allow: { maxChangedFiles: 10, requireAllTestsPassed: true, allowedPathPrefixes: ["src/", "test/"] },
	deny: { pathPrefixes: ["config/prod/", "infra/", "db/migration/"], keywords: ["DROP TABLE", "production"] },
};

// ---------- 裁决器 ----------

export interface ApprovalDeps {
	policy: ApprovalPolicy;
	notify: NotifyService;
}

export interface ApprovalVerdict {
	decision: ApprovalDecision;
	reasons: string[];
}

export class ApprovalService {
	readonly #deps: ApprovalDeps;

	constructor(deps: ApprovalDeps) {
		this.#deps = deps;
	}

	decide(req: ApprovalRequest): ApprovalVerdict {
		const reasons: string[] = [];

		// 1. 禁止项 —— 直接驳回，不降级
		for (const f of req.changedFiles) {
			const hit = this.#deps.policy.deny.pathPrefixes.find((p) => f.startsWith(p));
			if (hit) return { decision: "rejected", reasons: [`命中禁止路径: ${f} (${hit})`] };
		}
		for (const kw of this.#deps.policy.deny.keywords) {
			if (req.diffSummary.includes(kw)) return { decision: "rejected", reasons: [`diff 命中禁止关键词: ${kw}`] };
		}

		// 2. 自动通过规则 —— 全部满足才通过
		const { allow } = this.#deps.policy;
		if (req.changedFiles.length > allow.maxChangedFiles) {
			reasons.push(`变更文件数 ${req.changedFiles.length} > ${allow.maxChangedFiles}`);
		}
		if (allow.requireAllTestsPassed && !(req.evidence.buildPassed && req.evidence.testsPassed)) {
			reasons.push("构建或测试未全量通过");
		}
		const outOfScope = req.changedFiles.filter((f) => !allow.allowedPathPrefixes.some((p) => f.startsWith(p)));
		if (outOfScope.length > 0) {
			reasons.push(`变更超出允许路径: ${outOfScope.join(", ")}`);
		}

		// 3. 全部满足 → 自动通过；否则 → 转人工（不确定时交给人）
		if (reasons.length === 0) {
			return { decision: "approved", reasons: ["满足全部自动通过规则"] };
		}
		return { decision: "manual", reasons };
	}

	/** 转人工：通知责任人（工单 owner → 代码 owner → 值班，逐级兜底），超时升级由 notify 侧处理 */
	async escalateToManual(req: ApprovalRequest, verdict: ApprovalVerdict): Promise<void> {
		await this.#deps.notify.sendManualApprovalNeeded({
			ticketId: req.ticketId,
			ref: req.ref,
			applicant: req.applicant,
			reasons: verdict.reasons,
		});
	}
}
