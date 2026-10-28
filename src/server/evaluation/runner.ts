/**
 * 批量实验编排器。
 *
 * 负责：按 system × case × repeat 执行、冻结 manifest、捕获单次异常并继续。
 * 判分与聚合不在本文件内，保证“执行采集”和“结论计算”互不污染。
 */

import { randomUUID } from "node:crypto";
import type { Dataset } from "./dataset.ts";
import { evaluateRun } from "./evaluator.ts";
import {
	type FailureDistributionRow,
	type MetricSummary,
	type SliceDimension,
	type SliceSummary,
	summarizeByDimension,
	summarizeFailureDistribution,
	summarizeMetrics,
	summarizeStability,
	type TaskStabilitySummary,
} from "./metrics.ts";
import type {
	CaseRunResult,
	EvalCase,
	EvaluationManifest,
	EvaluationSystem,
	EvaluationSystemDescriptor,
	ObservedRun,
} from "./types.ts";

export interface EvaluationRunnerOptions {
	/** 覆盖数据集中的 repeatK；不传则逐 case 使用协议值 */
	repeats?: number;
	/** 实验标签，用于报告与追踪 */
	label?: string;
	now?: () => Date;
}

export interface SystemEvaluationSummary {
	system: EvaluationSystemDescriptor;
	results: CaseRunResult[];
	metrics: MetricSummary;
	stability: TaskStabilitySummary[];
	slices: Record<SliceDimension, SliceSummary[]>;
	failures: FailureDistributionRow[];
}

export interface EvaluationResult {
	manifest: EvaluationManifest;
	label?: string;
	systems: SystemEvaluationSummary[];
}

function failedObservation(
	evalCase: EvalCase,
	system: EvaluationSystem,
	repeatIndex: number,
	error: Error,
	started: number,
	kind: "system" | "infrastructure" = "system",
): ObservedRun {
	return {
		caseId: evalCase.caseId,
		systemId: system.id,
		repeatIndex,
		disposition: evalCase.expected.allowedDispositions[0] as ObservedRun["disposition"],
		actions: [],
		checks: evalCase.expected.checks.map((check) => ({
			checkId: check.id,
			status: "not_run",
			evidence: `运行异常：${error.message}`,
		})),
		interventions: [],
		unsafeActions: [],
		unauthorizedAccess: false,
		// 运行在进入任何决策/动作前异常退出，没有可审计的审批决策；
		// 缺证据会阻止交付，但不能把基础设施故障误报成安全红线。
		auditComplete: true,
		trace: {
			milestones: [],
			toolCalls: 0,
			repeatedToolCalls: 0,
			invalidLoop: false,
			claimedComplete: false,
			budgetExceeded: false,
			timedOut: false,
		},
		usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
		durationMs: Math.max(0, Date.now() - started),
		error: { kind, stage: "intake", message: error.message },
	};
}

function normalizeIdentity(
	evalCase: EvalCase,
	system: EvaluationSystem,
	repeatIndex: number,
	observed: ObservedRun,
): ObservedRun {
	if (observed.caseId === evalCase.caseId && observed.systemId === system.id && observed.repeatIndex === repeatIndex) {
		return observed;
	}
	return {
		...observed,
		caseId: evalCase.caseId,
		systemId: system.id,
		repeatIndex,
		error: observed.error ?? {
			kind: "system",
			stage: "intake",
			message: `适配器返回了错误的身份坐标：expected ${evalCase.caseId}/${system.id}/${repeatIndex}，got ${observed.caseId}/${observed.systemId}/${observed.repeatIndex}`,
		},
	};
}

const SLICE_DIMENSIONS: SliceDimension[] = ["family", "difficulty", "alertType", "dataset", "tag"];

export class EvaluationRunner {
	readonly #now: () => Date;

	constructor(options: Pick<EvaluationRunnerOptions, "now"> = {}) {
		this.#now = options.now ?? (() => new Date());
	}

	async run(
		dataset: Dataset,
		systems: EvaluationSystem[],
		options: EvaluationRunnerOptions = {},
	): Promise<EvaluationResult> {
		if (systems.length === 0) throw new Error("至少需要一个被评估系统");
		const ids = new Set(systems.map((system) => system.id));
		if (ids.size !== systems.length) throw new Error("被评估系统 id 不可重复");

		const startedAt = this.#now().toISOString();
		const results: CaseRunResult[] = [];
		const repeatPlan: Record<string, number> = {};

		for (const system of systems) {
			for (const evalCase of dataset.cases) {
				const repeatK = options.repeats ?? evalCase.protocol.repeatK;
				if (!Number.isInteger(repeatK) || repeatK <= 0) {
					throw new Error(`case ${evalCase.caseId} 的 repeatK 非法：${repeatK}`);
				}
				repeatPlan[`${system.id}/${evalCase.caseId}`] = repeatK;
				for (let repeatIndex = 0; repeatIndex < repeatK; repeatIndex += 1) {
					const started = Date.now();
					let observed: ObservedRun;
					try {
						observed = await system.run(evalCase, { repeatIndex });
					} catch (error) {
						observed = failedObservation(evalCase, system, repeatIndex, error as Error, started);
					}
					const normalized = normalizeIdentity(evalCase, system, repeatIndex, observed);
					results.push({
						evalCase,
						observed: normalized,
						verdict: evaluateRun(evalCase, normalized),
					});
				}
			}
		}

		const descriptors = systems.map((system) => ({
			id: system.id,
			version: system.version,
			evidenceLevel: system.evidenceLevel,
		}));
		const manifest: EvaluationManifest = {
			runId: randomUUID(),
			datasetName: dataset.name,
			datasetVersion: dataset.version,
			datasetHash: dataset.hash,
			caseCount: dataset.cases.length,
			systems: descriptors,
			startedAt,
			finishedAt: this.#now().toISOString(),
			repeatPlan,
		};

		const summaries: SystemEvaluationSummary[] = descriptors.map((descriptor) => {
			const systemResults = results.filter((result) => result.observed.systemId === descriptor.id);
			const slices = Object.fromEntries(
				SLICE_DIMENSIONS.map((dimension) => [dimension, summarizeByDimension(systemResults, dimension)]),
			) as Record<SliceDimension, SliceSummary[]>;
			return {
				system: descriptor,
				results: systemResults,
				metrics: summarizeMetrics(systemResults),
				stability: summarizeStability(systemResults),
				slices,
				failures: summarizeFailureDistribution(systemResults),
			};
		});

		return { manifest, label: options.label, systems: summaries };
	}
}
