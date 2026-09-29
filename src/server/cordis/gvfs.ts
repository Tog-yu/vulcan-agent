/**
 * GVFS 大仓三层检索（DEV_SPEC §14 P5-1，技术方案 4.2）。
 *
 * 一句话：服务端负责全局找代码，本地负责当前修改，GVFS 负责按需取文件。
 *   L1 远端索引：全仓检索（全文 + 语义向量），回答"代码在哪里"
 *   L2 本地工作区：只存 dirty 文件的内容哈希做**修正**，不建索引
 *   L3 GVFS：按需下载目标文件，下载后核验版本
 *
 * 四项接口要求（4.2）：
 *   1. 权限在召回前过滤（下推到检索层，不靠事后裁剪）
 *   2. 结果携带版本坐标 repo/branch/file_path/commit/content_hash
 *   3. 本地覆盖以内容哈希为准，不以时间为准
 *   4. 按需下载后必须核验版本；不一致显式告警，不得静默替换
 *
 * 外部依赖：企业索引服务（待核 2026-09-28）——三层都做成可注入接口，
 * 服务就绪后替换实现即可，Agent 侧契约不变。
 */

import type { PluginContext, RetrievalPlugin, RetrievalQuery, RetrievalResult } from "./index.ts";

/** L1 远端索引客户端（企业索引服务接口；待核——实现就绪前用 mock/只读代理） */
export interface RemoteIndexClient {
	/** 权限下推：allowedRepos 在服务端过滤后才返回候选 */
	search(query: string, opts: { allowedRepos: string[]; topK: number }): Promise<RemoteCandidate[]>;
	/** 索引新鲜度：索引 commit 与仓库最新提交的滞后（G1 风险监控） */
	freshness(): Promise<{ commit: string; lagMs: number }>;
}

export interface RemoteCandidate {
	repo: string;
	branch: string;
	filePath: string;
	commit: string;
	contentHash: string;
	snippet: string;
}

/** L2 本地工作区层：路径 → 内容哈希（仅 dirty 文件，无索引） */
export interface WorkspaceLayer {
	/** 本地文件的内容哈希；文件不在本地（GVFS 虚拟占位）返回 null */
	localHash(filePath: string): string | null;
}

/** L3 GVFS：按需取单个文件 */
export interface GvfsClient {
	fetchFile(repo: string, branch: string, filePath: string, commit: string): Promise<{ content: string; contentHash: string; bytes: number }>;
}

export interface GvfsPluginOptions {
	remote: RemoteIndexClient;
	workspace: WorkspaceLayer;
	gvfs: GvfsClient;
	topK?: number;
	/** 索引新鲜度告警阈值（lagMs 超过触发 onAlert） */
	freshnessLagThresholdMs?: number;
	/** 版本核验告警（不一致 → 告警交 Agent 决定，不静默替换） */
	onStale?: (info: { filePath: string; expectedHash: string; actualHash: string }) => void;
	/** 新鲜度告警 */
	onFreshnessAlert?: (info: { lagMs: number; thresholdMs: number }) => void;
}

/** FNV-1a 内容哈希（与 retrieval.ts 同口径） */
export function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * GVFS 检索插件：普通项目形态（cordis/retrieval.ts）的大仓对位实现。
 * 额外产出 P5-2 的两项量纲：单次检索按需下载量、索引新鲜度。
 */
export function createGvfsRetrievalPlugin(opts: GvfsPluginOptions): RetrievalPlugin & { stats(): GvfsStats } {
	const topK = opts.topK ?? 5;
	const freshnessThreshold = opts.freshnessLagThresholdMs ?? 30 * 60 * 1000; // 默认 30min
	const stats: GvfsStats = { queries: 0, onDemandDownloads: 0, onDemandBytes: 0, staleExcluded: 0, localCovered: 0, freshnessLagMs: 0 };

	return {
		kind: "retrieval",
		name: "gvfs-retrieval",
		description: "大仓三层检索：远端索引 + 本地哈希覆盖 + GVFS 按需读取核验",
		setup(_ctx: PluginContext) {},
		dispose() {},
		stats() {
			return { ...stats };
		},
		async retrieve(query: RetrievalQuery): Promise<RetrievalResult[]> {
			stats.queries += 1;

			// —— 要求 1：权限在召回前过滤（allowedRepos 下推服务端）——
			const fresh = await opts.remote.freshness();
			stats.freshnessLagMs = fresh.lagMs;
			if (fresh.lagMs > freshnessThreshold) {
				// G1 索引滞后风险：显式告警，不静默使用过期索引结论
				opts.onFreshnessAlert?.({ lagMs: fresh.lagMs, thresholdMs: freshnessThreshold });
			}
			const candidates = await opts.remote.search(query.text, { allowedRepos: query.allowedRepos, topK: query.topK ?? topK });

			const results: RetrievalResult[] = [];
			for (const c of candidates) {
				// —— 要求 3：本地覆盖以内容哈希为准 ——
				const localHash = opts.workspace.localHash(c.filePath);
				if (localHash !== null) {
					if (localHash === c.contentHash) {
						// 本地与远端一致 → 直接用本地（免下载）
						stats.localCovered += 1;
						results.push(toResult(c, "local-covered"));
						continue;
					}
					// 本地 dirty（内容不同）→ 以本地为准修正远端结果
					stats.localCovered += 1;
					results.push(toResult(c, "local-dirty-overrides"));
					continue;
				}

				// —— 要求 4：按需下载后核验版本 ——
				const file = await opts.gvfs.fetchFile(c.repo, c.branch, c.filePath, c.commit);
				stats.onDemandDownloads += 1;
				stats.onDemandBytes += file.bytes;
				const actualHash = fnv1a(file.content);
				if (actualHash !== c.contentHash) {
					// 不一致：显式告警交 Agent 决定，不得静默替换（防止主干误当开发分支代码）
					stats.staleExcluded += 1;
					opts.onStale?.({ filePath: c.filePath, expectedHash: c.contentHash, actualHash });
					continue;
				}
				results.push(toResult(c, "gvfs-verified"));
			}
			return results;
		},
	};
}

export interface GvfsStats {
	queries: number;
	/** 单次检索的按需下载量（次数 + 字节）——证明"确实没做全仓扫描"的唯一指标 */
	onDemandDownloads: number;
	onDemandBytes: number;
	/** 本地哈希覆盖命中次数（没有触发下载） */
	localCovered: number;
	/** 版本核验失败剔除数 */
	staleExcluded: number;
	/** 最近一次索引新鲜度滞后 */
	freshnessLagMs: number;
}

function toResult(c: RemoteCandidate, via: string): RetrievalResult {
	return {
		repo: c.repo,
		branch: c.branch,
		filePath: c.filePath,
		commit: c.commit,
		contentHash: c.contentHash,
		snippet: c.snippet,
		via,
	} as RetrievalResult;
}
