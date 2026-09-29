import { describe, expect, it } from "vitest";
import {
	LocalRetrievalPlugin,
	contentHashOf,
	type IndexCandidate,
	type RetrievalQuery,
} from "../src/server/cordis/retrieval.ts";
import type { PluginContext, RetrievalResult } from "../src/server/cordis/index.ts";

const ctx: PluginContext = { log: () => {}, workspaceRoot: "/tmp/ws", allowedRepos: ["svc/auth"] };

function cand(over: Partial<IndexCandidate>): IndexCandidate {
	return {
		repo: "svc/auth",
		branch: "main",
		filePath: "src/login.ts",
		commit: "abc1234",
		contentHash: "deadbeef",
		snippet: "export function login() {}",
		score: 0.9,
		...over,
	};
}

function pluginWith(
	candidates: IndexCandidate[],
	opts: ConstructorParameters<typeof LocalRetrievalPlugin>[1] = {},
) {
	const source = { search: async (_q: RetrievalQuery) => candidates };
	const p = new LocalRetrievalPlugin(source, opts);
	p.setup(ctx);
	return p;
}

describe("P3-6 检索插件（普通项目形态）", () => {
	it("权限前置过滤：越权仓库的候选在召回前被丢弃", async () => {
		const p = pluginWith([
			cand({ repo: "svc/auth" }),
			cand({ repo: "svc/payment", filePath: "src/pay.ts" }),
			cand({ repo: "infra/misc", filePath: "conf.yaml" }),
		]);
		const hits = await p.retrieve({ text: "login", allowedRepos: ["svc/auth"] });
		expect(hits.map((h) => h.repo)).toEqual(["svc/auth"]);
	});

	it("结果携带完整版本坐标（repo/branch/file_path/commit/content_hash）", async () => {
		const p = pluginWith([cand({})]);
		const hits: RetrievalResult[] = await p.retrieve({ text: "x", allowedRepos: ["svc/auth"] });
		expect(hits[0]).toMatchObject({
			repo: "svc/auth",
			branch: "main",
			filePath: "src/login.ts",
			commit: "abc1234",
			contentHash: "deadbeef",
		});
	});

	it("版本核验：实际内容哈希 ≠ 索引声明 → 触发核验告警且不静默使用", async () => {
		const stale: Array<{ filePath: string; declared: string; actual: string }> = [];
		const p = pluginWith([cand({}), cand({ filePath: "src/expired.ts" })], {
			onStale: (w) => stale.push(w),
			readFile: (_repo, _branch, filePath) => {
				// expired.ts 实际内容已被修改 → 哈希对不上声明
				const text = filePath === "src/expired.ts" ? "changed content" : "export function login() {}";
				return text;
			},
		});
		// 让第一个候选的声明哈希与实际内容一致
		const good = contentHashOf("export function login() {}");
		(p as unknown as { source: { search: (q: RetrievalQuery) => Promise<IndexCandidate[]> } }).source.search =
			async () => [cand({ contentHash: good }), cand({ filePath: "src/expired.ts" })];
		const hits = await p.retrieve({ text: "x", allowedRepos: ["svc/auth"] });
		expect(hits.map((h) => h.filePath)).toEqual(["src/login.ts"]); // 过期候选被剔除
		expect(stale).toHaveLength(1);
		expect(stale[0].filePath).toBe("src/expired.ts");
	});

	it("缺版本坐标（commit/content_hash 缺失）的候选被丢弃", async () => {
		const p = pluginWith([cand({ contentHash: "" }), cand({ commit: "" })]);
		const hits = await p.retrieve({ text: "x", allowedRepos: ["svc/auth"] });
		expect(hits).toHaveLength(0);
	});

	it("输出预算：topK 限条数，超长 snippet 截断", async () => {
		const p = pluginWith(
			[cand({}), cand({ filePath: "b.ts" }), cand({ filePath: "c.ts" })],
			{ maxSnippetLength: 10 },
		);
		const hits = await p.retrieve({ text: "x", allowedRepos: ["svc/auth"], topK: 2 });
		expect(hits).toHaveLength(2);
		expect(hits[0].snippet.length).toBeLessThanOrEqual(10);
	});

	it("未 setup 直接检索 → 拒绝", async () => {
		const source = { search: async () => [] as IndexCandidate[] };
		const p = new LocalRetrievalPlugin(source);
		await expect(p.retrieve({ text: "x", allowedRepos: ["svc/auth"] })).rejects.toThrow(/VULCAN_RETRIEVAL_001/);
	});

	it("readFile 抛错（文件不可读）→ 候选剔除不崩溃", async () => {
		const good = contentHashOf("export function login() {}");
		const p = pluginWith([cand({ contentHash: good })], {
			readFile: () => {
				throw new Error("EACCES");
			},
		});
		const hits = await p.retrieve({ text: "x", allowedRepos: ["svc/auth"] });
		expect(hits).toHaveLength(0);
	});
});
