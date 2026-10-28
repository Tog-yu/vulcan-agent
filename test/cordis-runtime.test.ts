import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCordisRuntime, type CordisRuntime } from "../src/server/cordis/bootstrap.ts";
import { createBuiltinToolPlugins } from "../src/server/cordis/builtin-tools.ts";
import type { PluginContext, RetrievalPlugin, ToolPlugin } from "../src/server/cordis/index.ts";

const pluginCtx: PluginContext = {
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

function retrievalPlugin(opts?: { disposed?: string[]; name?: string }): RetrievalPlugin {
	return {
		kind: "retrieval",
		name: opts?.name ?? "retrieval-mock",
		setup() {},
		dispose() {
			opts?.disposed?.push("retrieval-mock");
		},
		async retrieve() {
			return [];
		},
	};
}

describe("P3-1b 真·cordis v4 装配（参考 DSH）", () => {
	it("装配成功：Service 挂到 ctx（tools/retrieval/agent），插件经 cordis fiber 挂载", async () => {
		const rt: CordisRuntime = await createCordisRuntime([toolPlugin("read_file"), retrievalPlugin()], pluginCtx);
		expect(rt.tools.list().map((t) => t.tool)).toEqual(["read_file"]);
		expect(rt.tools.get("read_file")?.name).toBe("read_file");
		expect(rt.tools.getByToolName("read_file")?.tool).toBe("read_file");
		expect(rt.retrieval.get()?.name).toBe("retrieval-mock");
		// agent 服务已注册但未绑定 runner → 取用应抛错
		expect(() => rt.agent.get()).toThrow(/VULCAN_CORDIS_008/);
		await rt.dispose();
	});

	it("空插件清单 → 拒绝装配（与旧注册表同语义）", async () => {
		await expect(createCordisRuntime([], pluginCtx)).rejects.toThrow(/VULCAN_CORDIS_001/);
	});

	it("重名插件 → 注册期 fail-fast", async () => {
		await expect(createCordisRuntime([toolPlugin("x"), toolPlugin("x")], pluginCtx)).rejects.toThrow(/重复/);
	});

	it("检索插件多于一个 → 注册期 fail-fast", async () => {
		await expect(
			createCordisRuntime([retrievalPlugin(), retrievalPlugin({ name: "retrieval-mock-2" })], pluginCtx),
		).rejects.toThrow(/至多一个/);
	});

	it("setup 抛错 → fail-fast：逆序 dispose 已挂载插件后上抛", async () => {
		const disposed: string[] = [];
		await expect(
			createCordisRuntime([toolPlugin("a", { disposed }), toolPlugin("bad", { setupThrows: true })], pluginCtx),
		).rejects.toThrow(/setup 失败/);
		expect(disposed).toEqual(["a"]);
	});

	it("dispose 逆序回收全部插件（cordis fiber 托管生命周期）", async () => {
		const disposed: string[] = [];
		const ret = retrievalPlugin({ disposed });
		const rt = await createCordisRuntime([toolPlugin("t1", { disposed }), ret, toolPlugin("t2", { disposed })], pluginCtx);
		await rt.dispose();
		expect(disposed).toEqual(["t2", "retrieval-mock", "t1"]); // 逆序
	});

	it("内置工具插件：execute 走 scope 校验 + 工具输出形状对齐 extractEvidence 约定", async () => {
		// workspaceRoot 指向临时目录，避免测试污染真实路径
		const tmpRoot = await mkdtemp(join(tmpdir(), "vulcan-cordis-test-"));
		await mkdir(join(tmpRoot, "svc/auth/src"), { recursive: true });
		const rt = await createCordisRuntime(createBuiltinToolPlugins({ ...pluginCtx, workspaceRoot: tmpRoot }), {
			...pluginCtx,
			workspaceRoot: tmpRoot,
		});
		const write = rt.tools.getByToolName("write_file")!;
		const out = await write.execute({ path: "svc/auth/src/a.ts", content: "hi" }, {
			allowedRepos: ["svc/auth"],
			forbiddenPaths: [],
		});
		expect(out.ok).toBe(true);
		expect((out.data as { patchRef: string }).patchRef).toContain("svc/auth/src/a.ts");

		// 越权路径 → 工具抛错（pi 循环会转错误 tool result）
		const read = rt.tools.getByToolName("read_file")!;
		await expect(
			read.execute({ path: "../etc/passwd" }, { allowedRepos: ["svc/auth"], forbiddenPaths: [] }),
		).rejects.toThrow(/越权/);
		await rt.dispose();
		await rm(tmpRoot, { recursive: true, force: true });
	});
});
