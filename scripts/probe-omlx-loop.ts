/**
 * oMLX 工具调用循环探针：直接用 pi-ai streamSimple 复现 AgentLoop 的调用形态。
 * 用途：当 e2e 出现 stop_reason=error 时，区分是 oMLX 服务问题还是 vulcan 装配问题。
 *
 * 运行：OMLX_API_KEY=1234 node --experimental-strip-types scripts/probe-omlx-loop.ts
 */

import { assembleOmlxPipeline } from "../src/server/cli/omlx-model.ts";

const tools = [
	{
		name: "read_file",
		description: "读取文件内容",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "相对路径" } },
			required: ["path"],
		},
	},
];

async function main(): Promise<void> {
	const { streamFn, model } = await assembleOmlxPipeline();
	const messages = [
		{ role: "system", content: "你是测试助手。必须通过工具完成任务。" },
		{ role: "user", content: "读取文件 src/login.ts 并告诉我 verifyToken 函数的问题。" },
	];

	console.log("=== turn 1 ===");
	const stream = streamFn(model, { messages, tools }, { maxTokens: 2048 });
	for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
		const t = event.type as string;
		if (t !== "start" && t !== "ping") console.log(JSON.stringify(event).slice(0, 400));
	}
}

main().catch((err) => {
	console.error("probe failed:", err);
	process.exit(1);
});
