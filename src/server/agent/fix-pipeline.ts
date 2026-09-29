/**
 * 修复链路执行器（DEV_SPEC §14 P3-7，技术方案 8.1 主链路步骤 3-4）。
 *
 * 职责：编排 vulcan 任务的执行阶段——
 *   复现 → 定位 → 修改 → 测试（AgentLoop 四阶段 ReAct）
 *   → 产出补丁引用与验证证据 → 提交审批引擎裁决
 *   → approved: 受控创建 PR（经本模块的 createPr 出口，不绕过审批）
 *   → rejected: 记审计，任务转 rejected
 *   → manual:   任务转 awaiting_manual，由审批回调收口（approval/flow.ts）
 *
 * session 三层记忆全程挂接：每步 toolResult 进滚动窗口，usage 进预算。
 */

import type { DatabaseSync } from "node:sqlite";
import { VulcanAgentLoop, applyBudgetOutcome, type AgentRunDeps, type AgentRunOutput } from "../agent/index.ts";
import { ApprovalEngine, type Adjudication } from "../approval/engine.ts";
import { writeApprovalAudit } from "../approval/audit.ts";
import { transitionTask } from "../harness/state-machine.ts";
import { SessionManager, type SessionMessage } from "../session/index.ts";
import type { ApprovalRequest, InternalEvent } from "../types.ts";
import type { ToolPlugin, ToolScope, RetrievalPlugin } from "../cordis/index.ts";

export interface FixPipelineDeps {
	db: DatabaseSync;
	agent: VulcanAgentLoop;
	/** 任务允许的仓库与禁止路径 */
	scope: ToolScope;
	/** 可用工具（cordis registry 提供） */
	tools: ToolPlugin[];
	/** 检索插件（可缺省：缺省时提示词注明"仅分析模式"） */
	retrieval?: RetrievalPlugin;
	/** 受控 PR 创建出口（审批通过后调用；生产=GitHub API，测试=mock） */
	createPr: (input: { taskId: string; branch: string; title: string; patchRef: string }) => Promise<{ url: string }>;
	/** 审批策略引擎（缺省用默认规则） */
	engine?: ApprovalEngine;
}

export interface FixRunInput {
	taskId: string;
	event: InternalEvent;
	issue: string;
	/** 审批输入的其他要素（调用方从任务上下文组装） */
	applicant?: string;
	impactScope?: string;
}

export interface FixRunOutput {
	outcome: "pr_created" | "rejected" | "manual_review" | "budget_stopped" | "failed";
	prUrl?: string;
	verdict?: Adjudication;
	reason?: string;
}

/** 从 AgentRunOutput 提取补丁引用与证据（工具插件约定输出形状） */
function extractEvidence(run: AgentRunOutput): { patchRef: string; changedFiles: string[]; testsPassed: boolean; buildPassed: boolean } | null {
	const toolResults = run.messages.filter((m) => (m as { role: string }).role === "toolResult") as unknown as Array<{
		content: Array<{ type: string; text?: string }>;
	}>;
	let patchRef: string | null = null;
	let testsPassed = false;
	let buildPassed = false;
	for (const tr of toolResults) {
		const text = tr.content?.find((c) => c.type === "text")?.text;
		if (!text) continue;
		try {
			const data = JSON.parse(text) as { patchRef?: string; testsPassed?: boolean; buildPassed?: boolean };
			if (data.patchRef) patchRef = data.patchRef;
			if (data.testsPassed !== undefined) testsPassed = data.testsPassed;
			if (data.buildPassed !== undefined) buildPassed = data.buildPassed;
		} catch {
			// 非 JSON 工具结果（如 read_file 的纯文本），跳过
		}
	}
	return patchRef ? { patchRef, changedFiles: [], testsPassed, buildPassed } : null;
}

export class FixPipeline {
	constructor(private readonly deps: FixPipelineDeps) {}

	async run(input: FixRunInput): Promise<FixRunOutput> {
		const { db, agent, scope, tools } = this.deps;
		const session = new SessionManager(db, input.taskId, {
			summarize: (early, evicted) => `${early ?? ""}此前执行过 ${evicted.length} 步（结论已合并）`,
			budgetTokens: 200_000,
		});

		// —— 执行层（8.1 步骤 3）：AgentLoop 四阶段 ReAct ——
		const systemPrompt = [
			"你是 Vulcan 修复 Agent。按 复现→定位→修改→测试 四阶段工作。",
			"只能使用提供的工具；产出补丁后必须运行测试取得验证证据。",
			this.deps.retrieval ? "检索上下文经检索插件获得，引用需带版本坐标。" : "当前为仅分析模式（无检索插件）。",
		].join("\n");
		const prompt = `告警事件：${input.event.ref}\n问题：${input.issue}`;

		let run: AgentRunOutput;
		try {
			run = await agent.run({
				prompt,
				systemPrompt,
				tools,
				scope,
				onEvent: (evt) => {
					// toolResult 进 session 滚动窗口（三层短期记忆挂接）
					if (evt.type === "tool_execution_end") {
						const msg: SessionMessage = {
							role: "toolResult",
							content: JSON.stringify(evt.result ?? {}),
							toolName: evt.toolName,
							timestamp: Date.now(),
						};
						session.append(msg);
					}
				},
			});
		} catch (err) {
			transitionTask(db, input.taskId, "running", "failed");
			return { outcome: "failed", reason: (err as Error).message };
		}

		// —— 预算强停联动（P3-3）：任务转 failed，trace 已在 agent 审计 ——
		let budgetStopped = false;
		applyBudgetOutcome(run.endReason, run.usage, {
			onBudgetExceeded: () => {
				budgetStopped = true;
			},
		});
		if (budgetStopped) {
			transitionTask(db, input.taskId, "running", "failed");
			return { outcome: "budget_stopped", reason: "预算超限强停" };
		}

		// —— 提取证据，无补丁产出 → 仅分析建议 ——
		const evidence = extractEvidence(run);
		if (!evidence) {
			transitionTask(db, input.taskId, "running", "failed");
			return { outcome: "failed", reason: "Agent 未产出补丁引用（仅分析建议）" };
		}

		// —— 审批（8.1 步骤 4）：五输入裁决 ——
		// 状态机语义：裁决产出即 running → awaiting_approval，再按结论分流终态
		if (!transitionTask(db, input.taskId, "running", "awaiting_approval")) {
			transitionTask(db, input.taskId, "running", "failed");
			return { outcome: "failed", reason: "任务状态已被并发修改，无法进入审批" };
		}
		const ticketId = `AP-${input.taskId}`;
		const request: ApprovalRequest = {
			ticketId,
			ref: input.taskId,
			applicant: input.applicant ?? "vulcan-agent",
			intent: `修复 ${input.issue}`,
			changedFiles: evidence.changedFiles,
			diffSummary: evidence.patchRef,
			impactScope: input.impactScope ?? scope.allowedRepos.join(","),
			evidence: {
				buildPassed: evidence.buildPassed,
				testsPassed: evidence.testsPassed,
				commands: ["npm test"],
			},
		};
		const engine = this.deps.engine ?? new ApprovalEngine();
		const verdict = engine.decide(request);

		// 审计先落（审批结果不能没有留痕）
		writeApprovalAudit(db, { ticketId, taskId: input.taskId, req: request, verdict, decidedBy: "system" });

		if (verdict.decision === "rejected") {
			transitionTask(db, input.taskId, "awaiting_approval", "rejected"); // 禁止项驳回 → 任务终态 rejected（审计已记）
			return { outcome: "rejected", verdict, reason: verdict.reasons.join("; ") };
		}
		if (verdict.decision === "manual") {
			// approvals 行已由 writeApprovalAudit 写入（decision='manual', decided_by='system'），
			// 人工回调 flow.ts 直接查这行；此处不重复 INSERT（复合主键会冲突）
			transitionTask(db, input.taskId, "awaiting_approval", "awaiting_manual");
			return { outcome: "manual_review", verdict, reason: verdict.reasons.join("; ") };
		}
		// —— approved：受控创建 PR（不绕过审批）——
		transitionTask(db, input.taskId, "awaiting_approval", "done");
		const taskState = session.getTaskState();
		const pr = await this.deps.createPr({
			taskId: input.taskId,
			branch: taskState.context.branch ?? `fix/${input.taskId}`,
			title: `fix: ${input.issue}`,
			patchRef: evidence.patchRef,
		});
		return { outcome: "pr_created", prUrl: pr.url, verdict };
	}
}
