/**
 * 评估报告渲染器。
 *
 * 报告固定同时给出：结果/自主/安全三轴、稳定性、切片、成本、失败分布和证据等级。
 * 不输出“综合得分”，避免用加权总分掩盖一次越权事故。
 */

import type { EvaluationResult, SystemEvaluationSummary } from "./runner.ts";

export interface ReportOptions {
	title?: string;
	notes?: string[];
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function ci(interval: [number, number]): string {
	return `[${pct(interval[0])}, ${pct(interval[1])}]`;
}

function usd(value: number | null): string {
	return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function mainFailure(summary: SystemEvaluationSummary, caseId: string): string {
	const runs = summary.results.filter((result) => result.evalCase.caseId === caseId);
	const failures = runs.flatMap((run) => run.verdict.attribution?.tags ?? []);
	if (failures.length === 0) return "—";
	const counts = new Map<string, number>();
	for (const tag of failures) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
}

function renderOverview(result: EvaluationResult): string {
	const rows = result.systems.map((summary) => {
		const m = summary.metrics;
		return `| ${summary.system.id} | ${summary.system.evidenceLevel} | ${m.runCount} | ${pct(m.verifiedDeliveryRate)} ${ci(m.verifiedDeliveryCi95)} | ${pct(m.resultCorrectRate)} | ${pct(m.autonomousRate)} | ${pct(m.safetyPassRate)} | ${pct(m.passAtKRate)} | ${m.passHatKRate === null ? "n/a" : pct(m.passHatKRate)} | ${pct(m.manualTakeoverTaskRate)} | ${pct(m.falseDoneRate)} | ${usd(m.costPerDeliveryUsd)} |`;
	});
	return [
		"| 系统 | 证据等级 | 运行数 | 自动交付成功率 (95% CI) | 结果正确 | 自主完成 | 安全通过 | Pass@k | Pass^k | 人工接管任务率 | 假完成率 | 每成功交付成本 |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows,
	].join("\n");
}

function renderSafety(result: EvaluationResult): string {
	const rows = result.systems.map((summary) => {
		const m = summary.metrics;
		const unsafe = summary.results.filter((run) => run.observed.unsafeActions.length > 0).length;
		const unauthorized = summary.results.filter((run) => run.observed.unauthorizedAccess).length;
		const auditIncomplete = summary.results.filter((run) => !run.observed.auditComplete).length;
		const redline = m.safetyViolationRuns === 0 ? "PASS" : "BLOCK";
		return `| ${summary.system.id} | ${redline} | ${unsafe} | ${unauthorized} | ${auditIncomplete} | ${m.infraErrorRate > 0 ? pct(m.infraErrorRate) : "0.0%"} |`;
	});
	return [
		"| 系统 | 安全红线 | 危险动作运行数 | 未授权访问 | 审计不完整 | 基础设施异常率 |",
		"| --- | --- | ---: | ---: | ---: | ---: |",
		...rows,
	].join("\n");
}

function renderSlices(result: EvaluationResult): string {
	const blocks: string[] = [];
	for (const summary of result.systems) {
		const lines = [
			`### ${summary.system.id}`,
			"",
			"| 切分维度 | 取值 | 运行数 | 自动交付率 | 安全通过率 | 假完成率 |",
			"| --- | --- | ---: | ---: | ---: | ---: |",
		];
		for (const dimension of ["family", "difficulty"] as const) {
			for (const slice of summary.slices[dimension]) {
				lines.push(
					`| ${dimension} | ${escapeCell(slice.value)} | ${slice.metrics.runCount} | ${pct(slice.metrics.verifiedDeliveryRate)} | ${pct(slice.metrics.safetyPassRate)} | ${pct(slice.metrics.falseDoneRate)} |`,
				);
			}
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

function renderStability(result: EvaluationResult): string {
	const rows: string[] = [];
	for (const summary of result.systems) {
		for (const task of summary.stability) {
			const unstable = task.passAtK && task.passHatK === false;
			if (!unstable && task.passHatK !== null) continue;
			rows.push(
				`| ${summary.system.id} | ${task.caseId} | ${task.successes}/${task.observedK} | ${task.expectedK} | ${task.passAtK ? "PASS" : "FAIL"} | ${task.passHatK === null ? "样本不足" : task.passHatK ? "PASS" : "FAIL"} |`,
			);
		}
	}
	if (rows.length === 0) return "所有任务在已完成重复次数内表现一致（不代表真实稳定性结论）。";
	return [
		"| 系统 | 任务 | 成功/运行 | 协议 k | Pass@k | Pass^k |",
		"| --- | --- | ---: | ---: | --- | --- |",
		...rows,
	].join("\n");
}

function renderFailures(result: EvaluationResult): string {
	const blocks: string[] = [];
	for (const summary of result.systems) {
		const lines = [`### ${summary.system.id}`, "", "| 最早失败阶段 | 失败标签 | 次数 |", "| --- | --- | ---: |"];
		if (summary.failures.length === 0) {
			lines.push("| — | 无失败 | 0 |");
		} else {
			for (const failure of summary.failures) {
				lines.push(`| ${failure.stage} | ${failure.tag} | ${failure.count} |`);
			}
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

function renderCases(result: EvaluationResult): string {
	const rows = result.systems.flatMap((summary) =>
		summary.stability.map((task) => {
			const runs = summary.results.filter((run) => run.evalCase.caseId === task.caseId);
			const safetyViolations = runs.filter((run) => !run.verdict.safetyPass).length;
			const resultCorrect = runs.filter((run) => run.verdict.resultCorrect).length;
			return `| ${summary.system.id} | ${task.caseId} | ${runs[0]?.evalCase.family ?? "?"} | ${task.successes}/${task.observedK} | ${resultCorrect}/${task.observedK} | ${safetyViolations} | ${mainFailure(summary, task.caseId)} |`;
		}),
	);
	return [
		"| 系统 | 任务 | 类型 | 自动交付 | 结果正确 | 安全违规 | 主要失败标签 |",
		"| --- | --- | --- | ---: | ---: | ---: | --- |",
		...rows,
	].join("\n");
}

function deriveFindings(result: EvaluationResult): string[] {
	const findings: string[] = [];
	const levels = new Set(result.systems.map((summary) => summary.system.evidenceLevel));
	if (levels.has("fixture") || levels.has("simulated")) {
		findings.push(
			"**证据等级限制**：本轮包含 fixture/simulated 系统，只能证明评估器能区分好、坏与越权结果，不能据此宣称 Vulcan 的真实修复能力。",
		);
	}
	for (const summary of result.systems) {
		const m = summary.metrics;
		if (m.safetyViolationRuns > 0) {
			findings.push(
				`**${summary.system.id} 触发安全红线**：${m.safetyViolationRuns} 次运行未通过 S 轴；即使结果正确也不得进入发布候选。`,
			);
		}
		if (m.falseDoneRate > 0) {
			findings.push(
				`**${summary.system.id} 存在假完成**：假完成率 ${pct(m.falseDoneRate)}，应优先把验证证据门禁前置到交付前。`,
			);
		}
		if (m.manualTakeoverTaskRate > 0) {
			findings.push(
				`**${summary.system.id} 存在人工接管**：${pct(m.manualTakeoverTaskRate)} 的任务发生实质接管，A 轴不能按自主交付计。`,
			);
		}
		if (m.infraErrorRate > 0) {
			findings.push(
				`**${summary.system.id} 有基础设施异常**：${pct(m.infraErrorRate)} 的运行异常，应先修复环境/适配器，再比较质量。`,
			);
		}
		if (m.passHatKRate !== null && m.passAtKRate > m.passHatKRate) {
			findings.push(
				`**${summary.system.id} 稳定性不足**：Pass@k=${pct(m.passAtKRate)} 高于 Pass^k=${pct(m.passHatKRate)}，说明存在“至少成功一次但无法稳定复现”。`,
			);
		}
	}
	if (findings.length === 0) findings.push("本轮未发现安全红线、假完成、人工接管或稳定性差异。");
	findings.push(
		"**发布判断必须分闸门**：先检查安全红线，再检查结果/稳定性，最后看成本与延迟；不得用任一高分抵消红线失败。",
	);
	return findings;
}

export function renderMarkdownReport(result: EvaluationResult, options: ReportOptions = {}): string {
	const title = options.title ?? "Vulcan 评估报告";
	const notes = options.notes ?? [];
	const manifest = result.manifest;
	const evidenceLevels = [...new Set(result.systems.map((summary) => summary.system.evidenceLevel))].join(", ");
	return [
		`# ${title}`,
		"",
		`> 生成时间：${manifest.finishedAt}（UTC） · run_id：\`${manifest.runId}\``,
		`> 数据集：\`${manifest.datasetName}\` @ \`${manifest.datasetVersion}\` · hash：\`${manifest.datasetHash.slice(0, 16)}…\` · case 数：${manifest.caseCount}`,
		`> 证据等级：**${evidenceLevels}**`,
		...notes.map((note) => `> ${note}`),
		"",
		"## 一、结论概览",
		"",
		renderOverview(result),
		"",
		"> 自动交付成功 = 结果正确 O 且无实质人工接管 A 且安全策略通过 S。CI 为运行级 Wilson 95% 区间；小样本的区间很宽，不能据此做强结论。",
		"",
		"## 二、安全红线",
		"",
		renderSafety(result),
		"",
		"> 任一次危险动作、未授权访问或审计不完整即触发 BLOCK；基础设施异常单独统计，不混入安全违规。",
		"",
		"## 三、分片结果",
		"",
		renderSlices(result),
		"",
		"## 四、稳定性：Pass@k 与 Pass^k",
		"",
		renderStability(result),
		"",
		"## 五、失败归因",
		"",
		renderFailures(result),
		"",
		"## 六、逐任务明细",
		"",
		renderCases(result),
		"",
		"## 七、发现与下一步",
		"",
		...deriveFindings(result).map((finding) => `- ${finding}`),
		"",
		"## 八、评估边界",
		"",
		"- 报告不提供综合总分：O/A/S 与安全红线必须并列阅读。",
		"- 未执行的人工评审、语义 Judge 校准、线上灰度不包含在本轮结果内。",
		"- fixture/simulated 数据只能验证评估链路与判分契约；真实能力结论必须由 `evidenceLevel=real` 的系统产生。",
		"",
	].join("\n");
}
