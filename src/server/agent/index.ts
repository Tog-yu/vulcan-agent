/**
 * AgentLoop —— 默认 Pi（技术方案 · 四）
 *
 * ReAct 式循环：模型提出动作 → Pi 调用工具 → 工具返回结果 → 带结果再请求模型。
 * 主模型不直接操作工作区；工具执行一律经 Cordis 工具插件，在允许范围内进行。
 *
 * 框架阶段：先定接口，Pi runtime 的装配在依赖安装后填充。
 */

export interface AgentTaskInput {
	taskId: string;
	/** 修复目标：来自工单 / 告警的任务描述 */
	objective: string;
	/** 允许操作的仓库与路径范围 */
	workspace: string;
	/** 本次任务允许使用的工具插件名 */
	allowedTools: string[];
}

export interface AgentTaskResult {
	success: boolean;
	/** 产出物：修改的文件、执行的命令、验证证据 */
	changedFiles: string[];
	commands: string[];
	buildPassed: boolean;
	testsPassed: boolean;
	summary: string;
}

export interface AgentLoop {
	run(input: AgentTaskInput): Promise<AgentTaskResult>;
}

/** 占位实现：接口冻结，供 Harness 与测试先行对接 */
export class StubAgentLoop implements AgentLoop {
	async run(input: AgentTaskInput): Promise<AgentTaskResult> {
		console.log(`[agent] stub run: ${input.taskId} — ${input.objective}`);
		return {
			success: false,
			changedFiles: [],
			commands: [],
			buildPassed: false,
			testsPassed: false,
			summary: "AgentLoop 尚未接入 Pi runtime（框架占位）",
		};
	}
}
