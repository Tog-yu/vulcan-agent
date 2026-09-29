/**
 * 大仓专属指标（DEV_SPEC §14 P5-2，技术方案 9.1 GVFS 两量纲）。
 *
 * 都不能用响应耗时替代：
 *   - 单次检索的按需下载量：唯一能证明"确实没做全仓扫描"的指标（架构底线）
 *   - 索引新鲜度：索引 commit 与仓库最新提交的滞后时长（G1 索引滞后风险）
 * 面板可见 + 超阈值告警。
 */

import type { GvfsStats } from "../cordis/gvfs.ts";

export interface GvfsMetricsSnapshot {
	/** 检索总次数 */
	queries: number;
	/** 按需下载次数与字节（面板量纲一） */
	onDemandDownloads: number;
	onDemandBytes: number;
	/** 平均单次检索下载量（字节/次） */
	avgBytesPerQuery: number;
	/** 本地哈希覆盖命中率（覆盖越多，下载越少，架构越健康） */
	localCoverageRate: number;
	/** 版本核验剔除率（过高说明索引质量差） */
	staleExclusionRate: number;
	/** 索引新鲜度滞后（面板量纲二） */
	indexFreshnessLagMs: number;
}

export interface GvfsAlert {
	kind: "freshness" | "excessive-download";
	message: string;
	value: number;
	threshold: number;
}

export interface GvfsMetricsOptions {
	/** 新鲜度告警阈值（默认 30 分钟） */
	freshnessThresholdMs?: number;
	/** 单次检索按需下载量告警阈值（字节；超过视为疑似全仓扫描） */
	maxDownloadBytesPerQuery?: number;
}

/** 从 GVFS 插件统计生成面板快照 + 超阈值告警 */
export function gvfsMetricsSnapshot(stats: GvfsStats, opts: GvfsMetricsOptions = {}): { metrics: GvfsMetricsSnapshot; alerts: GvfsAlert[] } {
	const alerts: GvfsAlert[] = [];
	const freshnessThreshold = opts.freshnessThresholdMs ?? 30 * 60 * 1000;
	const maxBytesPerQuery = opts.maxDownloadBytesPerQuery ?? 50 * 1024 * 1024; // 50MB

	const avgBytesPerQuery = stats.queries > 0 ? stats.onDemandBytes / stats.queries : 0;
	const localCoverageRate = stats.localCovered + stats.onDemandDownloads > 0 ? stats.localCovered / (stats.localCovered + stats.onDemandDownloads) : 0;
	const staleExclusionRate = stats.localCovered + stats.onDemandDownloads > 0 ? stats.staleExcluded / (stats.localCovered + stats.onDemandDownloads) : 0;

	if (stats.freshnessLagMs > freshnessThreshold) {
		alerts.push({
			kind: "freshness",
			message: `索引新鲜度滞后 ${(stats.freshnessLagMs / 60000).toFixed(1)} 分钟，超过阈值——存在依据过期代码修改代码的风险（G1）`,
			value: stats.freshnessLagMs,
			threshold: freshnessThreshold,
		});
	}
	if (avgBytesPerQuery > maxBytesPerQuery) {
		alerts.push({
			kind: "excessive-download",
			message: `单次检索平均按需下载 ${(avgBytesPerQuery / 1024 / 1024).toFixed(1)}MB 超阈值——疑似破坏"不做全仓扫描"架构底线`,
			value: avgBytesPerQuery,
			threshold: maxBytesPerQuery,
		});
	}

	return {
		metrics: {
			queries: stats.queries,
			onDemandDownloads: stats.onDemandDownloads,
			onDemandBytes: stats.onDemandBytes,
			avgBytesPerQuery,
			localCoverageRate,
			staleExclusionRate,
			indexFreshnessLagMs: stats.freshnessLagMs,
		},
		alerts,
	};
}
