/**
 * 评估数据集加载与校验。
 *
 * 数据集采用 JSONL：一行一个 case，便于审查、diff、按行定位坏数据。
 * 加载阶段只做契约校验，不执行任何命令、不接触被评估对象。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	CHECK_KINDS,
	type CheckKind,
	DISPOSITIONS,
	type Difficulty,
	type Disposition,
	EVALUATION_STAGES,
	type EvalCase,
	type EvaluationStage,
	TASK_FAMILIES,
	type TaskFamily,
} from "./types.ts";

export interface Dataset {
	name: string;
	version: string;
	hash: string;
	cases: EvalCase[];
}

export interface DatasetLoadOptions {
	name?: string;
	version?: string;
}

export class DatasetValidationError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`评估数据集校验失败（${issues.length} 项）：\n- ${issues.join("\n- ")}`);
		this.name = "DatasetValidationError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string, issues: string[]): string {
	if (typeof value !== "string" || value.trim() === "") {
		issues.push(`${path} 必须是非空字符串`);
		return "";
	}
	return value;
}

function requireStringArray(value: unknown, path: string, issues: string[]): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
		issues.push(`${path} 必须是非空字符串数组`);
		return [];
	}
	return value as string[];
}

function requireNumber(value: unknown, path: string, issues: string[], positive = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
		issues.push(`${path} 必须是${positive ? "正" : "有限"}数字`);
		return 0;
	}
	return value;
}

function parseCheck(raw: unknown, path: string, issues: string[], seen: Set<string>): void {
	if (!isRecord(raw)) {
		issues.push(`${path} 必须是对象`);
		return;
	}
	const id = requireString(raw.id, `${path}.id`, issues);
	if (id) {
		if (seen.has(id)) issues.push(`${path}.id 重复：${id}`);
		seen.add(id);
	}
	if (!EVALUATION_STAGES.includes(raw.stage as EvaluationStage)) {
		issues.push(`${path}.stage 非法：${String(raw.stage)}`);
	}
	if (!CHECK_KINDS.includes(raw.kind as CheckKind)) {
		issues.push(`${path}.kind 非法：${String(raw.kind)}`);
	}
	if (raw.required !== undefined && typeof raw.required !== "boolean") {
		issues.push(`${path}.required 必须是 boolean`);
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		issues.push(`${path}.description 必须是字符串`);
	}
}

/**
 * 从文本解析数据集。校验失败时一次性返回全部问题，避免修一条报一条。
 */
export function parseDataset(text: string, options: DatasetLoadOptions & { sourcePath?: string } = {}): Dataset {
	const issues: string[] = [];
	const cases: EvalCase[] = [];
	const seenCaseIds = new Set<string>();
	const lines = text.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]?.trim() ?? "";
		if (!line) continue;
		const lineNo = index + 1;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch (error) {
			issues.push(`第 ${lineNo} 行 JSON 解析失败：${(error as Error).message}`);
			continue;
		}
		const path = `第 ${lineNo} 行`;
		if (!isRecord(raw)) {
			issues.push(`${path} 必须是 JSON object`);
			continue;
		}

		const caseId = requireString(raw.caseId, `${path}.caseId`, issues);
		if (caseId) {
			if (seenCaseIds.has(caseId)) issues.push(`${path}.caseId 重复：${caseId}`);
			seenCaseIds.add(caseId);
		}
		const caseVersion = requireNumber(raw.caseVersion, `${path}.caseVersion`, issues, true);
		const dataset = requireString(raw.dataset, `${path}.dataset`, issues);
		if (!TASK_FAMILIES.includes(raw.family as TaskFamily)) {
			issues.push(`${path}.family 非法：${String(raw.family)}`);
		}
		const alertType = requireString(raw.alertType, `${path}.alertType`, issues);
		if (!["easy", "medium", "hard"].includes(String(raw.difficulty))) {
			issues.push(`${path}.difficulty 非法：${String(raw.difficulty)}`);
		}
		const tags = requireStringArray(raw.tags, `${path}.tags`, issues);

		if (!isRecord(raw.input)) {
			issues.push(`${path}.input 必须是对象`);
		}
		const input = (isRecord(raw.input) ? raw.input : {}) as Record<string, unknown>;
		const issue = requireString(input.issue, `${path}.input.issue`, issues);
		const repoHints = requireStringArray(input.repoHints, `${path}.input.repoHints`, issues);
		const allowedActions = requireStringArray(input.allowedActions, `${path}.input.allowedActions`, issues);
		if (!isRecord(input.constraints)) issues.push(`${path}.input.constraints 必须是对象`);

		const expectedRaw = isRecord(raw.expected) ? raw.expected : {};
		if (!isRecord(raw.expected)) issues.push(`${path}.expected 必须是对象`);
		const allowedDispositions = Array.isArray(expectedRaw.allowedDispositions) ? expectedRaw.allowedDispositions : [];
		if (allowedDispositions.length === 0) {
			issues.push(`${path}.expected.allowedDispositions 不能为空`);
		}
		for (const disposition of allowedDispositions) {
			if (!DISPOSITIONS.includes(disposition as Disposition)) {
				issues.push(`${path}.expected.allowedDispositions 含非法动作：${String(disposition)}`);
			}
		}
		const forbiddenActions = Array.isArray(expectedRaw.forbiddenActions)
			? requireStringArray(expectedRaw.forbiddenActions, `${path}.expected.forbiddenActions`, issues)
			: [];
		const overlap = forbiddenActions.filter((action) => allowedActions.includes(action));
		if (overlap.length > 0) {
			issues.push(`${path} 配置冲突：动作同时被允许和禁止：${overlap.join(", ")}`);
		}

		const checksRaw = Array.isArray(expectedRaw.checks) ? expectedRaw.checks : [];
		if (checksRaw.length === 0) issues.push(`${path}.expected.checks 不能为空`);
		const checkIds = new Set<string>();
		checksRaw.forEach((check, checkIndex) => {
			parseCheck(check, `${path}.expected.checks[${checkIndex}]`, issues, checkIds);
		});
		const requiredChecks = checksRaw.filter((check) => isRecord(check) && check.required !== false);
		if (checksRaw.length > 0 && requiredChecks.length === 0) {
			issues.push(`${path}.expected.checks 至少需要一项 required 证据`);
		}

		const protocolRaw = isRecord(raw.protocol) ? raw.protocol : {};
		if (!isRecord(raw.protocol)) issues.push(`${path}.protocol 必须是对象`);
		const repeatK = requireNumber(protocolRaw.repeatK, `${path}.protocol.repeatK`, issues, true);
		if (repeatK > 0 && !Number.isInteger(repeatK)) {
			issues.push(`${path}.protocol.repeatK 必须是整数`);
		}
		const memoryMode = requireString(protocolRaw.memoryMode, `${path}.protocol.memoryMode`, issues);
		if (memoryMode && !["clean", "approved_only", "observed"].includes(memoryMode)) {
			issues.push(`${path}.protocol.memoryMode 非法：${memoryMode}`);
		}
		const budgetRaw = isRecord(protocolRaw.budget) ? protocolRaw.budget : {};
		if (!isRecord(protocolRaw.budget)) issues.push(`${path}.protocol.budget 必须是对象`);
		const maxSteps = requireNumber(budgetRaw.maxSteps, `${path}.protocol.budget.maxSteps`, issues, true);
		const maxCostUsd = requireNumber(budgetRaw.maxCostUsd, `${path}.protocol.budget.maxCostUsd`, issues);
		const maxDurationMs = requireNumber(budgetRaw.maxDurationMs, `${path}.protocol.budget.maxDurationMs`, issues, true);

		cases.push({
			caseId,
			caseVersion,
			dataset,
			family: raw.family as TaskFamily,
			alertType,
			difficulty: raw.difficulty as Difficulty,
			tags,
			input: {
				issue,
				repoHints,
				allowedActions,
				constraints: isRecord(input.constraints) ? input.constraints : {},
			},
			expected: {
				allowedDispositions: allowedDispositions as Disposition[],
				forbiddenActions,
				checks: checksRaw as EvalCase["expected"]["checks"],
			},
			protocol: {
				repeatK,
				memoryMode: memoryMode as EvalCase["protocol"]["memoryMode"],
				budget: { maxSteps, maxCostUsd, maxDurationMs },
			},
		});
	}

	if (cases.length === 0 && issues.length === 0) issues.push("数据集为空");
	if (issues.length > 0) throw new DatasetValidationError(issues);

	return {
		name: options.name ?? options.sourcePath ?? "inline-dataset",
		version: options.version ?? "unversioned",
		hash: createHash("sha256").update(text).digest("hex"),
		cases,
	};
}

export function loadDataset(path: string, options: DatasetLoadOptions = {}): Dataset {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new DatasetValidationError([`读取数据集失败：${(error as Error).message}`]);
	}
	return parseDataset(text, {
		...options,
		sourcePath: options.name ?? path,
	});
}
