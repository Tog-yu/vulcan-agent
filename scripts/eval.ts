/**
 * 评估体系资格验证 CLI（fixture only）。
 *
 * 用途：验证数据集契约、判分轴、安全红线、稳定性统计和报告渲染是否可靠。
 * 不调用真实模型，不得把产物当作 Vulcan 修复能力报告。
 *
 * 运行：
 *   node --experimental-strip-types scripts/eval.ts
 *   node --experimental-strip-types scripts/eval.ts --dataset eval/datasets/harness-smoke.jsonl --repeats 3
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { loadDataset } from "../src/server/evaluation/dataset.ts";
import { ContractFixtureSystem } from "../src/server/evaluation/fixture-system.ts";
import { renderMarkdownReport } from "../src/server/evaluation/report.ts";
import { EvaluationRunner } from "../src/server/evaluation/runner.ts";
import type { EvaluationSystem } from "../src/server/evaluation/types.ts";

function readArg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1] as string;
	const prefix = `--${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

function timestampLabel(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function main(): void {
	const datasetPath = readArg("dataset", "eval/datasets/harness-smoke.jsonl");
	const repeatsRaw = readArg("repeats", "");
	const repeats = repeatsRaw ? Number(repeatsRaw) : undefined;
	if (repeats !== undefined && (!Number.isInteger(repeats) || repeats <= 0)) {
		throw new Error(`--repeats 必须是正整数，收到 ${repeatsRaw}`);
	}
	const label = readArg("label", "harness-qualification");
	const now = new Date();
	const outPath = readArg("out", `docs/evaluation-report-${timestampLabel(now)}.md`);
	const jsonPath = readArg("json", outPath.replace(/\.md$/i, ".json"));
	const outDir = dirname(outPath);
	mkdirSync(outDir, { recursive: true });
	mkdirSync(dirname(jsonPath), { recursive: true });

	const dataset = loadDataset(datasetPath, {
		name: basename(datasetPath, extname(datasetPath)),
		version: readArg("dataset-version", "v1"),
	});

	const systems: EvaluationSystem[] = [
		new ContractFixtureSystem("fixture-golden", "golden"),
		new ContractFixtureSystem("fixture-overclaim", "overclaim"),
		new ContractFixtureSystem("fixture-unsafe", "unsafe"),
		new ContractFixtureSystem("fixture-manual", "manual"),
		new ContractFixtureSystem("fixture-flaky", "flaky"),
	];
	const requested = readArg("systems", "all");
	const selected =
		requested === "all" ? systems : systems.filter((system) => requested.split(",").includes(system.id));
	if (selected.length === 0) {
		throw new Error(`--systems 未匹配任何 fixture：${requested}`);
	}

	const runner = new EvaluationRunner();
	runner
		.run(dataset, selected, { repeats, label })
		.then((result) => {
			const report = renderMarkdownReport(result, {
				title: "Vulcan 评估体系资格验证报告",
				notes: [
					"**本轮为 fixture 资格验证，不是 Vulcan 真实修复能力评估。**",
					"目的：验证评估器能否稳定区分 golden / overclaim / unsafe / manual / flaky 五类行为。",
					`数据集：${datasetPath} · case 数：${dataset.cases.length} · 运行数：${result.systems.reduce((sum, system) => sum + system.metrics.runCount, 0)}`,
				],
			});
			writeFileSync(outPath, report, "utf8");
			writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

			console.log(`评估完成：${result.manifest.runId}`);
			for (const system of result.systems) {
				const metrics = system.metrics;
				console.log(
					`${system.system.id}: 自动交付 ${metrics.verifiedDeliveryCount}/${metrics.runCount}，` +
						`安全违规 ${metrics.safetyViolationRuns}，假完成 ${(metrics.falseDoneRate * 100).toFixed(1)}%，` +
						`Pass^k ${metrics.passHatKRate === null ? "n/a" : `${(metrics.passHatKRate * 100).toFixed(1)}%`}`,
				);
			}
			console.log(`报告：${outPath}`);
			console.log(`原始结果：${jsonPath}`);
		})
		.catch((error) => {
			console.error("评估失败：", error);
			process.exitCode = 1;
		});
}

main();
