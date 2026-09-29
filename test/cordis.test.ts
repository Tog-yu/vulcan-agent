import { describe, expect, it } from "vitest";
import {
	createRegistry,
	type PluginContext,
	type RetrievalPlugin,
	type ToolPlugin,
} from "../src/server/cordis/index.ts";

const ctx: PluginContext = {
	log: () => {},
	workspaceRoot: "/tmp/ws",
	allowedRepos: ["svc/auth"],
};

function toolPlugin(name: string, opts?: { setupThrows?: boolean; disposed?: string[] }): ToolPlugin {
	return {
		kind: "tool",
		name,
		tool: name,
		description: "test tool",
		parameters: {},
		setup() {
			if (opts?.setupThrows) throw new Error("boom");
		},
		dispose() {
			opts?.disposed?.push(name);
		},
		async execute(input) {
			return { ok: true, data: { echoed: input } };
		},
	};
}

function retrievalPlugin(opts?: { disposed?: string[]; results?: unknown[]; name?: string }): RetrievalPlugin {
	return {
		kind: "retrieval",
		name: opts?.name ?? "retrieval-mock",
		setup() {},
		dispose() {
			opts?.disposed?.push("retrieval-mock");
		},
		async retrieve(query) {
			return (opts?.results ?? []) as never[];
		},
	};
}

describe("P3-1 cordis 插件契约与注册表", () => {
	it("正常装配：setup 按序执行，工具/检索可取用，dispose 逆序恰好各一次", async () => {
		const disposed: string[] = [];
		const tool1 = toolPlugin("read_file", { disposed });
		const tool2 = toolPlugin("write_file", { disposed });
		const ret = retrievalPlugin({ disposed });
		const reg = createRegistry([tool1, ret, tool2], ctx);
		expect(reg.ready).toBe(false);
		await reg.setupAll();
		expect(reg.ready).toBe(true);

		expect(reg.getTool("read_file")?.name).toBe("read_file");
		expect(reg.getTool("missing")).toBeUndefined();
		expect(reg.listTools().map((t) => t.tool)).toEqual(["read_file", "write_file"]);
		expect(reg.getRetrieval()?.name).toBe("retrieval-mock");

		await reg.disposeAll();
		expect(disposed).toEqual(["write_file", "retrieval-mock", "read_file"]); // 逆序
		expect(reg.ready).toBe(false);
	});

	it("setup 抛错 → fail-fast：回滚已 setup 插件（dispose 被调）后上抛，拒绝带病启动", async () => {
		const disposed: string[] = [];
		const ok1 = toolPlugin("a", { disposed });
		const ok2 = toolPlugin("b", { disposed });
		const bad = toolPlugin("bad", { setupThrows: true });
		const reg = createRegistry([ok1, ok2, bad], ctx);
		await expect(reg.setupAll()).rejects.toThrow(/bad.*setup 失败/);
		// 回滚：只有已 setup 的 a/b 被 dispose，且逆序
		expect(disposed).toEqual(["b", "a"]);
		expect(reg.ready).toBe(false);
	});

	it("注册期校验：空列表 / 重名 / 检索插件多于一个 → 直接抛错", () => {
		expect(() => createRegistry([], ctx)).toThrow(/VULCAN_CORDIS_001/);
		expect(() => createRegistry([toolPlugin("x"), toolPlugin("x")], ctx)).toThrow(/重复/);
		expect(() => createRegistry([retrievalPlugin(), retrievalPlugin({ name: "retrieval-mock-2" })], ctx)).toThrow(/至多一个/);
	});

	it("未装配完成时取用能力 → 拒绝", async () => {
		const reg = createRegistry([toolPlugin("t")], ctx);
		expect(() => reg.getTool("t")).toThrow(/VULCAN_CORDIS_005/);
		expect(() => reg.listTools()).toThrow(/VULCAN_CORDIS_007/);
		expect(() => reg.getRetrieval()).toThrow(/VULCAN_CORDIS_006/);
	});

	it("mock 检索插件替换默认实现全链路无感知：调用方只依赖契约", async () => {
		const results = [
			{
				repo: "svc/auth",
				branch: "main",
				filePath: "src/login.ts",
				commit: "abc1234",
				contentHash: "h1",
				snippet: "export function login() {}",
				score: 0.9,
			},
		];
		const ret = retrievalPlugin({ results });
		const reg = createRegistry([ret], ctx);
		await reg.setupAll();
		const hits = await reg.getRetrieval()!.retrieve({ text: "login", allowedRepos: ["svc/auth"] });
		expect(hits).toEqual(results); // 调用方拿到契约规定的版本坐标结构，感知不到是 mock
	});
});
