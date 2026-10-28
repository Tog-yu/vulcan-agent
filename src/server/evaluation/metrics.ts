/**
 * 评估指标聚合。
 *
 * 所有比例都带明确分母；Pass@k / Pass^k 按 task 聚合，其余过程/成本按 run 聚合。
 * 这里不产生综合总分：安全红线、结果、自主性和成本必须分别展示。
 */

import type { CaseRunResult, EvaluationStage, FailureTag } from "./types.ts";

export interface MetricSummary {
	taskCount: number;
	runCount: number;
	verifiedDeliveryCount: number;
	/** Avg@k 口径：所有重复运行的自动交付成功率 */
	verifiedDeliveryRate: number;
	verifiedDeliveryCi95: [number, number];
	resultCorrectRate: number;
	autonomousRate: number;
	safetyPassRate: number;
	safetyViolationRuns: number;
	manualTakeoverTaskRate: number;
	falseDoneRate: number;
	budgetStopRate: number;
	infraErrorRate: number;
	passAtKRate: number;
	/** 仅统计已达到协议 repeatK 的任务；无完整任务时为 null */
	passHatKRate: number | null;
	completeTaskCount: number;
	averageSteps: number;
	totalCostUsd: number;
	costPerDeliveryUsd: number | null;
	p50DurationMs: number;
	p95DurationMs: number;
}

export interface TaskStabilitySummary {
	caseId: string;
	systemId: string;
	observedK: number;
	expectedK: number;
	successes: number;
	passAtK: boolean;
	passHatK: boolean | null;
	stable: boolean;
}

export interface SliceSummary {
	key: string;
	value: string;
	metrics: MetricSummary;
}

function ratio(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

/** Wilson 95% 置信区间，避免小样本把比例说得过满 */
export function wilsonInterval(successes: number, total: number): [number, number] {
	if (total <= 0) return [0, 0];
	const z = 1.96;
	const p = successes / total;
	const denominator = 1 + (z * z) / total;
	const center = (p + (z * z) / (2 * total)) / denominator;
	const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
	return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function summarizeStability(results: CaseRunResult[]): TaskStabilitySummary[] {
	const tasks = new Map<string, CaseRunResult[]>();
	for (const result of results) {
		const key = `${result.observed.systemId}\u0000${result.evalCase.caseId}`;
		const list = tasks.get(key) ?? [];
		list.push(result);
		tasks.set(key, list);
	}

	return [...tasks.values()].map((runs) => {
		const first = runs[0] as CaseRunResult;
		const successes = runs.filter((run) => run.verdict.verifiedDelivery).length;
		const observedK = runs.length;
		const expectedK = first.evalCase.protocol.repeatK;
		return {
			caseId: first.evalCase.caseId,
			systemId: first.observed.systemId,
			observedK,
			expectedK,
			successes,
			passAtK: successes > 0,
			passHatK: observedK >= expectedK ? successes === observedK : null,
			stable: successes === observedK || successes === 0,
		};
	});
}

export function summarizeMetrics(results: CaseRunResult[]): MetricSummary {
	const runs = results.length;
	const successRuns = results.filter((result) => result.verdict.verifiedDelivery).length;
	const stability = summarizeStability(results);
	const completeTasks = stability.filter((task) => task.observedK >= task.expectedK);
	const taskGroups = new Map<string, CaseRunResult[]>();
	for (const result of results) {
		const list = taskGroups.get(result.evalCase.caseId) ?? [];
		list.push(result);
		taskGroups.set(result.evalCase.caseId, list);
	}
	const totalCost = results.reduce((sum, result) => sum + result.observed.usage.costUsd, 0);

	return {
		taskCount: taskGroups.size,
		runCount: runs,
		verifiedDeliveryCount: successRuns,
		verifiedDeliveryRate: ratio(successRuns, runs),
		verifiedDeliveryCi95: wilsonInterval(successRuns, runs),
		resultCorrectRate: ratio(results.filter((result) => result.verdict.resultCorrect).length, runs),
		autonomousRate: ratio(results.filter((result) => result.verdict.autonomous).length, runs),
		safetyPassRate: ratio(results.filter((result) => result.verdict.safetyPass).length, runs),
		safetyViolationRuns: results.filter((result) => !result.verdict.safetyPass).length,
		manualTakeoverTaskRate: ratio(
			[...taskGroups.values()].filter((taskRuns) =>
				taskRuns.some((run) => run.observed.interventions.some((item) => item.kind === "substantive")),
			).length,
			taskGroups.size,
		),
		falseDoneRate: ratio(results.filter((result) => result.verdict.falseDone).length, runs),
		budgetStopRate: ratio(results.filter((result) => result.observed.trace.budgetExceeded).length, runs),
		infraErrorRate: ratio(results.filter((result) => result.observed.error?.kind === "infrastructure").length, runs),
		passAtKRate: ratio(stability.filter((task) => task.passAtK).length, stability.length),
		passHatKRate:
			completeTasks.length > 0
				? ratio(completeTasks.filter((task) => task.passHatK === true).length, completeTasks.length)
				: null,
		completeTaskCount: completeTasks.length,
		averageSteps: ratio(
			results.reduce((sum, result) => sum + result.observed.usage.steps, 0),
			runs,
		),
		totalCostUsd: totalCost,
		costPerDeliveryUsd: successRuns > 0 ? totalCost / successRuns : null,
		p50DurationMs: percentile(
			results.map((result) => result.observed.durationMs),
			50,
		),
		p95DurationMs: percentile(
			results.map((result) => result.observed.durationMs),
			95,
		),
	};
}

export type SliceDimension = "family" | "difficulty" | "alertType" | "dataset" | "tag";

export function summarizeByDimension(results: CaseRunResult[], dimension: SliceDimension): SliceSummary[] {
	const groups = new Map<string, CaseRunResult[]>();
	for (const result of results) {
		const values =
			dimension === "tag"
				? result.evalCase.tags
				: [String(result.evalCase[dimension as keyof CaseRunResult["evalCase"]])];
		for (const value of values.length > 0 ? values : ["<empty>"]) {
			const list = groups.get(value) ?? [];
			list.push(result);
			groups.set(value, list);
		}
	}
	return [...groups.entries()]
		.map(([value, groupResults]) => ({ key: dimension, value, metrics: summarizeMetrics(groupResults) }))
		.sort((a, b) => a.value.localeCompare(b.value));
}

export interface FailureDistributionRow {
	stage: EvaluationStage;
	tag: FailureTag;
	count: number;
}

export function summarizeFailureDistribution(results: CaseRunResult[]): FailureDistributionRow[] {
	const counts = new Map<string, FailureDistributionRow>();
	for (const result of results) {
		if (!result.verdict.attribution) continue;
		for (const tag of result.verdict.attribution.tags) {
			const key = `${result.verdict.attribution.stage}\u0000${tag}`;
			const row = counts.get(key) ?? { stage: result.verdict.attribution.stage, tag, count: 0 };
			row.count += 1;
			counts.set(key, row);
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));
}
