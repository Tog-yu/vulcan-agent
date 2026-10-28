/**
 * 契约夹具系统（仅用于评估器资格验证）。
 *
 * 这些系统不调用模型、不修复代码，只按预设行为产生可观测结果，
 * 用来验证判分器能否正确区分：
 * - 全部证据通过；
 * - 自报完成但证据失败；
 * - 结果看似正确但越过安全红线；
 * - 具结果正确但依赖人工接管；
 * - 多次运行不稳定的 flaky 行为。
 */

import type { EvalCase, EvaluationSystem, HumanIntervention, ObservedCheck, ObservedRun } from "./types.ts";

export type FixtureBehavior = "golden" | "overclaim" | "unsafe" | "manual" | "flaky";

export class ContractFixtureSystem implements EvaluationSystem {
	readonly id: string;
	readonly version: string;
	readonly evidenceLevel = "fixture" as const;
	readonly behavior: FixtureBehavior;

	constructor(id: string, behavior: FixtureBehavior, version = "1.0.0") {
		this.id = id;
		this.behavior = behavior;
		this.version = version;
	}

	async run(evalCase: EvalCase, context: { repeatIndex: number }): Promise<ObservedRun> {
		const checks: ObservedCheck[] = evalCase.expected.checks.map((check) => ({
			checkId: check.id,
			status: "pass",
			evidence: `fixture evidence for ${check.id}`,
			durationMs: 10,
		}));
		const interventions: HumanIntervention[] = [];
		// 合格系统的动作必须来自 case 的允许动作，不能把“能改代码”套到纯降噪任务上。
		const actions = [...evalCase.input.allowedActions];
		const unsafeActions: string[] = [];
		let disposition = evalCase.expected.allowedDispositions[0] as ObservedRun["disposition"];

		if (this.behavior === "overclaim") {
			const lastRequired = [...evalCase.expected.checks].reverse().find((check) => check.required !== false);
			if (lastRequired) {
				const target = checks.find((check) => check.checkId === lastRequired.id);
				if (target) {
					target.status = "fail";
					target.evidence = "fixture: 自报完成但验证未通过";
				}
			}
		}

		if (this.behavior === "unsafe") {
			const forbidden = evalCase.expected.forbiddenActions[0] ?? "production_write";
			actions.push(forbidden);
			unsafeActions.push(forbidden);
		}

		if (this.behavior === "manual") {
			interventions.push({ kind: "substantive", stage: "execution", detail: "fixture: 人工给出根因" });
		} else if (disposition === "PLAN_AND_HANDOFF" || disposition === "REJECT_FORBIDDEN") {
			interventions.push({ kind: "expected_handoff", stage: "delivery", detail: "fixture: 策略要求的交接" });
		}

		if (this.behavior === "flaky" && context.repeatIndex % 2 === 1) {
			const first = checks[0];
			if (first) {
				first.status = "fail";
				first.evidence = "fixture: 第二次运行出现回归";
			}
		}

		// golden / unsafe 仍保持“允许的处置”以验证安全轴不能被结果轴抵消；
		// 其他行为也使用允许处置，隔离单一变量。
		disposition = evalCase.expected.allowedDispositions[0] as ObservedRun["disposition"];

		const milestones = [
			...new Set(evalCase.expected.checks.filter((check) => check.required !== false).map((check) => check.stage)),
		];
		return {
			caseId: evalCase.caseId,
			systemId: this.id,
			repeatIndex: context.repeatIndex,
			disposition,
			actions: [...new Set(actions)],
			checks,
			interventions,
			unsafeActions,
			unauthorizedAccess: false,
			auditComplete: true,
			trace: {
				milestones,
				toolCalls: milestones.length + 2,
				repeatedToolCalls: 0,
				invalidLoop: false,
				claimedComplete: true,
				budgetExceeded: false,
				timedOut: false,
			},
			usage: {
				steps: milestones.length + 2,
				inputTokens: 2_000,
				outputTokens: 400,
				costUsd: 0.08,
			},
			durationMs: 1_500,
		};
	}
}
