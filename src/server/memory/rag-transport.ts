/**
 * rag-transport —— 与 MODULAR-RAG-MCP-SERVER 的传输层（stdio / http 二选一，配置驱动）。
 *
 * 决策与 fiat-agent-pi 的 host/l1b/mcp-rag-transport.ts 同口径：
 * MVP 先 stdio（RAG server 现状），目标是 streamable-http；
 * 上层 `client.connect / callTool` 与 transport 无关，切换只改配置。
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface RagMcpConfig {
	transport: "stdio" | "http";

	// stdio 专用
	/** 默认 python3 */
	command?: string;
	/** 默认 ["-m", "src.mcp_server.server"]（MODULAR-RAG-MCP-SERVER） */
	args?: string[];
	/** RAG server 仓库根目录 */
	cwd?: string;

	// http 专用
	url?: string;
	/** 从该环境变量读 Bearer token */
	tokenEnv?: string;

	// 通用
	/** callTool 超时（毫秒），默认 30_000 */
	timeoutMs?: number;
}

export function createTransport(cfg: RagMcpConfig) {
	if (cfg.transport === "http") {
		if (!cfg.url) throw new Error("RAG MCP http transport 需要 config.url");
		const token = process.env[cfg.tokenEnv ?? ""] ?? "";
		return new StreamableHTTPClientTransport(new URL(cfg.url), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		});
	}
	return new StdioClientTransport({
		command: cfg.command ?? "python3",
		args: cfg.args ?? ["-m", "src.mcp_server.server"],
		cwd: cfg.cwd,
		// 关键：stdout 只留给 JSON-RPC 协议，RAG server 的日志必须走 stderr
		stderr: "pipe",
	});
}

/** 从环境变量构造配置；设置 RAG_MCP_URL 时走 http，否则走 stdio */
export function ragConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RagMcpConfig {
	const base: RagMcpConfig = { transport: "stdio", timeoutMs: 30_000 };
	if (env.RAG_MCP_URL) {
		return { ...base, transport: "http", url: env.RAG_MCP_URL, tokenEnv: env.RAG_MCP_TOKEN_ENV ?? "RAG_MCP_TOKEN" };
	}
	return {
		...base,
		command: env.RAG_MCP_COMMAND ?? "python3",
		args: env.RAG_MCP_ARGS?.split(" ").filter(Boolean) ?? ["-m", "src.mcp_server.server"],
		cwd: env.RAG_MCP_CWD,
	};
}
