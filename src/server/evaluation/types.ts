/**
 * 全新评估体系的公共契约。
 *
 * 设计原则（对应《Vulcan 全链路评估体系设计方案》）：
 * - 结果正确性 O、自主性 A、安全策略 S 三轴分开，禁止揉成一个加权总分；
 * - 判分依赖可执行证据与结构化检查项，不依赖模型自报完成；
 * - 预测/模拟系统必须显式标注 evidenceLevel，报告不得把夹具结果包装成真实能力。
 */

export const DISPOSITIONS = [
	"SUPPRESS",
	"MERGE",
	"ANALYZE_ONLY",
	"PLAN_AND_HANDOFF",
	"AUTO_FIX_REVIEW",
	"AUTO_FIX_POLICY",
	"REJECT_FORBIDDEN",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export const TASK_FAMILIES = [
	"code_fix",
	"config_fix",
	"analysis",
	"triage",
	"handoff",
	"recovery",
	"approval",
] as const;

export type TaskFamily = (typeof TASK_FAMILIES)[number];

export const EVALUATION_STAGES = [
	"intake",
	"triage",
	"understanding",
	"context",
	"retrieval",
	"planning",
	"tooling",
	"execution",
	"patch",
	"verification",
	"approval",
	"delivery",
] as const;

export type EvaluationStage = (typeof EVALUATION_STAGES)[number];

export const CHECK_KINDS = ["command", "file", "trace", "rubric", "manual"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type CheckStatus = "pass" | "fail" | "error" | "not_run";

export type EvidenceLevel = "real" | "fixture" | "simulated";

export type Difficulty = "easy" | "medium" | "hard";

export interface ExpectedCheck {
	/** 判分证据 ID；observed.checks 必须按此 ID 回填，缺失按失败处理 */
	id: string;
	/** 该项证据所属阶段，用于最早分叉点归因 */
	stage: EvaluationStage;
	/** 证据类型；command/file 属确定性验证，rubric 属语义判分 */
	kind: CheckKind;
	/** 默认 true；可选证据只记录，不影响结果正确性 */
	required?: boolean;
	description?: string;
}

export interface EvalCaseInput {
	issue: string;
	repoHints: string[];
	allowedActions: string[];
	constraints: Record<string, unknown>;
}

export interface EvalCaseExpected {
	/** 允许多种正确处置动作；实际动作不在集合内即分诊失败 */
	allowedDispositions: Disposition[];
	/** 任何命中都构成安全红线 */
	forbiddenActions: string[];
	/** 任务必须提供的证据；全部 required 通过才算 O 轴正确 */
	checks: ExpectedCheck[];
}

export interface EvalCaseProtocol {
	/** 同一任务重复次数；用于 Avg@k / Pass@k / Pass^k */
	repeatK: number;
	memoryMode: "clean" | "approved_only" | "observed";
	budget: {
		maxSteps: number;
		maxCostUsd: number;
		maxDurationMs: number;
	};
}

export interface EvalCase {
	caseId: string;
	caseVersion: number;
	dataset: string;
	family: TaskFamily;
	alertType: string;
	difficulty: Difficulty;
	tags: string[];
	input: EvalCaseInput;
	expected: EvalCaseExpected;
	protocol: EvalCaseProtocol;
}

export interface ObservedCheck {
	checkId: string;
	status: CheckStatus;
	evidence?: string;
	durationMs?: number;
}

export type HumanInterventionKind = "substantive" | "expected_handoff" | "clarification";

export interface HumanIntervention {
	kind: HumanInterventionKind;
	stage: EvaluationStage;
	detail?: string;
}

export interface ObservedTrace {
	milestones: EvaluationStage[];
	toolCalls: number;
	repeatedToolCalls: number;
	invalidLoop: boolean;
	claimedComplete: boolean;
	budgetExceeded: boolean;
	timedOut: boolean;
}

export interface ObservedUsage {
	steps: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface ObservedError {
	kind: "system" | "infrastructure";
	stage: EvaluationStage;
	message: string;
}

/**
 * 一次具体运行的观测结果。
 *
 * checks 必须来自真实执行环境、确定性规则或已校准的语义判分器，
 * 不能由被测模型直接填写“我通过了”。
 */
export interface ObservedRun {
	caseId: string;
	systemId: string;
	repeatIndex: number;
	disposition: Disposition;
	actions: string[];
	checks: ObservedCheck[];
	interventions: HumanIntervention[];
	unsafeActions: string[];
	unauthorizedAccess: boolean;
	auditComplete: boolean;
	trace: ObservedTrace;
	usage: ObservedUsage;
	durationMs: number;
	error?: ObservedError;
}

export interface EvaluationSystem {
	id: string;
	version: string;
	/** real = 真实系统；fixture = 契约夹具；simulated = 回放/模拟 */
	evidenceLevel: EvidenceLevel;
	run(evalCase: EvalCase, context: { repeatIndex: number; signal?: AbortSignal }): Promise<ObservedRun>;
}

export type FailureTag =
	| "wrong_disposition"
	| "missing_evidence"
	| "failed_check"
	| "safety_violation"
	| "unauthorized_access"
	| "audit_incomplete"
	| "human_takeover"
	| "budget_exceeded"
	| "timeout"
	| "false_done"
	| "invalid_loop"
	| "system_error"
	| "infra_error";

export interface FailureAttribution {
	/** 最早导致失败/降级的可证据阶段 */
	stage: EvaluationStage;
	tags: FailureTag[];
	evidence: string[];
}

export interface CheckVerdict {
	checkId: string;
	stage: EvaluationStage;
	required: boolean;
	status: CheckStatus;
	evidence?: string;
}

export interface RunVerdict {
	/** O：处置动作正确且全部 required 证据通过 */
	resultCorrect: boolean;
	/** A：没有实质人工接管，且未超预算/超时/异常 */
	autonomous: boolean;
	/** S：没有危险动作、未授权访问，审计完整 */
	safetyPass: boolean;
	/** 自动交付成功 = O && A && S */
	verifiedDelivery: boolean;
	checks: CheckVerdict[];
	falseDone: boolean;
	attribution: FailureAttribution | null;
}

export interface CaseRunResult {
	evalCase: EvalCase;
	observed: ObservedRun;
	verdict: RunVerdict;
}

export interface EvaluationSystemDescriptor {
	id: string;
	version: string;
	evidenceLevel: EvidenceLevel;
}

export interface EvaluationManifest {
	runId: string;
	datasetName: string;
	datasetVersion: string;
	datasetHash: string;
	caseCount: number;
	systems: EvaluationSystemDescriptor[];
	startedAt: string;
	finishedAt: string;
	/** 本次评估实际执行的重复次数（若 cases 不一致则取最大并逐案记录） */
	repeatPlan: Record<string, number>;
}
