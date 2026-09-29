/**
 * 检索插件——普通项目形态（DEV_SPEC §14 P3-6，技术方案 4.2/六）。
 *
 * 四项接口要求（《技术方案》4.2）：
 *   1. 权限在召回前过滤：scope 外仓库的候选在召回阶段直接丢弃，不进结果
 *   2. 结果携带版本坐标：repo/branch/file_path/commit/content_hash
 *   3. 哈希对齐：候选自带的 content_hash 必须与索引声明一致才可返回
 *   4. 版本核验：文件实际内容哈希 ≠ 索引声明 → 显式核验告警（不静默替换）
 *
 * 本实现是「普通项目」本地索引形态：索引由注入的候选源提供
 * （生产环境对接服务端索引/MODULAR-RAG-MCP-SERVER，测试注入 mock 候选）。
 * GVFS 大仓三层形态是独立插件（P5-1），实现同一 RetrievalPlugin 契约。
 */

import type {
	PluginContext,
	RetrievalPlugin,
	RetrievalQuery,
	RetrievalResult,
} from "./index.ts";

/** 索引候选（索引服务的原始返回，可能含越权/过期数据——插件负责过滤与核验） */
export interface IndexCandidate extends RetrievalResult {}

/** 候选源抽象：生产=HTTP 索引服务，测试=内存数组 */
export interface CandidateSource {
	search(query: RetrievalQuery): Promise<IndexCandidate[]>;
}

export interface RetrievalOptions {
	/** 版本核验不一致时的告警出口 */
	onStale?: (warning: { filePath: string; declared: string; actual: string }) => void;
	/** 实际读取文件内容做版本核验（普通项目本地形态）；不传则跳过下载核验 */
	readFile?: (repo: string, branch: string, filePath: string, commit: string) => Promise<string> | string;
	/** 返回条数上限（默认 10） */
	maxResults?: number;
	/** 单条 snippet 最大字符数（超预算截断，默认 2000） */
	maxSnippetLength?: number;
}

/** 简单确定性内容哈希（FNV-1a 32bit，hex）。生产可替换为更强哈希，接口不变 */
export function contentHashOf(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export class LocalRetrievalPlugin implements RetrievalPlugin {
	readonly name: string;
	kind = "retrieval" as const;

	private readonly source: CandidateSource;
	private readonly opts: RetrievalOptions;
	private ctx: PluginContext | null = null;

	constructor(source: CandidateSource, opts: RetrievalOptions = {}, name = "retrieval-local") {
		this.source = source;
		this.opts = opts;
		this.name = name;
	}

	setup(ctx: PluginContext): void {
		this.ctx = ctx;
	}

	dispose(): void {
		this.ctx = null;
	}

	async retrieve(query: RetrievalQuery): Promise<RetrievalResult[]> {
		if (!this.ctx) {
			throw new Error("VULCAN_RETRIEVAL_001: 检索插件未 setup，拒绝检索");
		}
		const allowed = new Set(query.allowedRepos);
		const candidates = await this.source.search(query);

		// —— 要求 1：权限在召回前过滤（越权候选直接丢弃，不进入结果集）——
		const inScope = candidates.filter((c) => allowed.has(c.repo));

		// —— 要求 3：哈希对齐（缺 content_hash 坐标的候选视为索引损坏，丢弃并告警）——
		const aligned: IndexCandidate[] = [];
		for (const c of inScope) {
			if (!c.commit || !c.contentHash) {
				this.ctx.log("检索候选缺少版本坐标，丢弃", { filePath: c.filePath });
				continue;
			}
			aligned.push(c);
		}

		// —— 要求 4：版本核验（本地形态：readFile 取实际内容算哈希对比声明）——
		// 不一致 → 显式告警 + 剔除（不静默使用过期内容）
		const verified: IndexCandidate[] = [];
		if (this.opts.readFile) {
			for (const c of aligned) {
				try {
					const actual = await this.opts.readFile(c.repo, c.branch, c.filePath, c.commit);
					if (contentHashOf(actual) !== c.contentHash) {
						this.opts.onStale?.({ filePath: c.filePath, declared: c.contentHash, actual: contentHashOf(actual) });
						continue;
					}
				} catch (err) {
					this.ctx.log("版本核验读取失败，剔除该候选", { filePath: c.filePath, err: (err as Error).message });
					continue;
				}
				verified.push(c);
			}
		} else {
			verified.push(...aligned);
		}

		// —— 输出预算：按条数与单条 snippet 长度截断 ——
		const maxResults = this.opts.maxResults ?? 10;
		const maxSnippet = this.opts.maxSnippetLength ?? 2000;
		return verified.slice(0, Math.max(1, query.topK ?? maxResults)).map((c) => ({
			...c,
			snippet: c.snippet.length > maxSnippet ? c.snippet.slice(0, maxSnippet) : c.snippet,
		}));
	}
}
