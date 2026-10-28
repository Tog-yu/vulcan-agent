/**
 * 内置工具插件集（cordis 功能层，DSH 风格）。
 *
 * 对齐 DSH 的 tool-* 包形态：每个插件实现 VulcanPlugin 契约（name/setup/dispose），
 * 由 bootstrap 包装成 cordis 插件挂载。主模型不直接操作工作区——
 * 文件/命令触达都封装在插件 execute(input, scope) 里。
 *
 * 当前实现为最小可用形态：本地工作区读/写 + 测试执行占位。
 * 生产替换点：按项目配置注入不同插件清单（cordis 的核心卖点）。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PluginContext, ToolPlugin, ToolResult, ToolScope } from "./index.ts";

/** 越权路径检查：目标路径必须落在允许的仓库根下 */
function assertInScope(ctx: PluginContext, scope: ToolScope, path: string): void {
	const abs = resolve(ctx.workspaceRoot, path);
	const ok = scope.allowedRepos.some((repo) => abs.startsWith(resolve(ctx.workspaceRoot, repo)));
	if (!ok) {
		throw new Error(`VULCAN_TOOL_001: 路径越权 ${path}（不在 allowedRepos 内）`);
	}
	if (scope.forbiddenPaths.some((f) => abs.startsWith(resolve(ctx.workspaceRoot, f)))) {
		throw new Error(`VULCAN_TOOL_002: 路径被禁 ${path}（forbiddenPaths 命中）`);
	}
}

/** 读文件工具 */
export function createReadFilePlugin(ctx: PluginContext): ToolPlugin {
	return {
		kind: "tool",
		name: "plugin-read-file",
		tool: "read_file",
		description: "读取工作区内指定文件的内容",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "相对 workspaceRoot 的文件路径" },
			},
			required: ["path"],
		},
		setup() {},
		dispose() {},
		async execute(input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
			const path = String(input.path ?? "");
			assertInScope(ctx, scope, path);
			const content = await readFile(resolve(ctx.workspaceRoot, path), "utf8");
			return { ok: true, data: { path, content, bytes: content.length } };
		},
	};
}

/** 写文件工具（产出 patchRef 供 FixPipeline 证据提取） */
export function createWriteFilePlugin(ctx: PluginContext): ToolPlugin {
	return {
		kind: "tool",
		name: "plugin-write-file",
		tool: "write_file",
		description: "写入/修改工作区内指定文件，产出补丁引用",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "相对 workspaceRoot 的文件路径" },
				content: { type: "string", description: "完整文件内容" },
			},
			required: ["path", "content"],
		},
		setup() {},
		dispose() {},
		async execute(input: Record<string, unknown>, scope: ToolScope): Promise<ToolResult> {
			const path = String(input.path ?? "");
			const content = String(input.content ?? "");
			assertInScope(ctx, scope, path);
			await writeFile(resolve(ctx.workspaceRoot, path), content, "utf8");
			return {
				ok: true,
				data: {
					path,
					bytes: content.length,
					// patchRef 是 FixPipeline 审批入口的证据键（extractEvidence 按此提取）
					patchRef: `local:${path}`,
				},
			};
		},
	};
}

/** 运行测试工具（占位实现：真实执行器由部署环境注入/替换插件） */
export function createRunTestsPlugin(ctx: PluginContext): ToolPlugin {
	return {
		kind: "tool",
		name: "plugin-run-tests",
		tool: "run_tests",
		description: "在指定测试套件上运行测试，返回验证证据",
		parameters: {
			type: "object",
			properties: {
				suite: { type: "string", description: "测试套件名（如 npm test 目标）" },
			},
			required: ["suite"],
		},
		setup() {},
		dispose() {},
		async execute(input: Record<string, unknown>): Promise<ToolResult> {
			// 占位：测试执行涉及沙箱/超时策略，生产实现由部署环境按项目注入。
			// 返回结构对齐 FixPipeline.extractEvidence 的提取约定。
			return {
				ok: true,
				data: {
					suite: String(input.suite ?? ""),
					testsPassed: false,
					buildPassed: false,
					note: "run_tests 插件为占位实现，生产环境须替换",
				},
			};
		},
	};
}

/** 默认工具集（entry.ts 按 config 组装；此处提供便捷工厂） */
export function createBuiltinToolPlugins(ctx: PluginContext): ToolPlugin[] {
	return [createReadFilePlugin(ctx), createWriteFilePlugin(ctx), createRunTestsPlugin(ctx)];
}
