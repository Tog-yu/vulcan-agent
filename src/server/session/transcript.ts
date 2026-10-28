/**
 * Transcript 会话账本 + artifact 外置（对照 Claude Code 的 Transcript JSONL）。
 *
 * 为什么单独一层：sessions 表是「当前快照」（会覆盖、会压缩），
 * transcript 是「发生过什么」（append-only、只追加）。两者解决不同问题：
 *   - 快照：模型下一步该看到什么
 *   - 账本：系统如何恢复、回放、审计、追责
 *
 * 目录布局（root 默认 data/）：
 *   <root>/transcripts/<taskId>.jsonl   一行一条记录
 *   <root>/artifacts/<taskId>/<sha256>.log  外置的大工具结果原文
 *   <root>/sessions/<taskId>.md          Session Memory 结构化笔记
 *
 * 崩溃一致性取舍：追加用 appendFileSync 单次 write（同介质原子性够用）；
 * 读取时逐行 JSON.parse，坏行跳过（断电半行不会毁掉整个账本）。
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactPointer, SessionStorage, TranscriptRecord } from "./types.ts";
import { SESSION_DEFAULTS } from "./types.ts";

const LEDGER_VERSION = 1 as const;

/** 文件系统实现：生产与测试共用（测试传临时 root） */
export class FileSessionStorage implements SessionStorage {
	private readonly root: string;
	/** 每个任务的 seq 缓存（首次写入时从账本尾部恢复） */
	private readonly seqCache = new Map<string, number>();
	private readonly lastIdCache = new Map<string, string | null>();

	constructor(root = process.env.VULCAN_DATA_DIR ?? "data") {
		this.root = root;
	}

	private ledgerPath(taskId: string): string {
		return join(this.root, "transcripts", `${taskId}.jsonl`);
	}

	private artifactPath(taskId: string, sha: string): string {
		return join(this.root, "artifacts", taskId, `${sha}.log`);
	}

	private memoryPath(taskId: string): string {
		return join(this.root, "sessions", `${taskId}.md`);
	}

	/** 追加一条记录（seq/id/parent_id 由账本维护） */
	append(
		taskId: string,
		rec: Omit<TranscriptRecord, "v" | "seq" | "id" | "parent_id"> & { parent_id?: string | null },
	): TranscriptRecord {
		const path = this.ledgerPath(taskId);
		mkdirSync(dirname(path), { recursive: true });

		let seq = this.seqCache.get(taskId);
		let prevId = this.lastIdCache.get(taskId) ?? null;
		if (seq === undefined) {
			// 首次写入：从已有账本尾部恢复 seq 与 parent
			const existing = this.read(taskId);
			seq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? 0) : 0;
			prevId = existing.length > 0 ? (existing[existing.length - 1]?.id ?? null) : null;
		}

		const next: TranscriptRecord = {
			v: LEDGER_VERSION,
			seq: seq + 1,
			id: `${taskId}:${seq + 1}`,
			...rec,
			parent_id: rec.parent_id ?? prevId,
		};
		appendFileSync(path, `${JSON.stringify(next)}\n`, "utf8");
		this.seqCache.set(taskId, next.seq);
		this.lastIdCache.set(taskId, next.id);
		return next;
	}

	/** 读账本；fromSeq 用于增量重建，tail 用于只取末尾若干条 */
	read(taskId: string, opts: { fromSeq?: number; tail?: number } = {}): TranscriptRecord[] {
		const path = this.ledgerPath(taskId);
		if (!existsSync(path)) return [];
		const out: TranscriptRecord[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const rec = JSON.parse(line) as TranscriptRecord;
				if (opts.fromSeq !== undefined && rec.seq < opts.fromSeq) continue;
				out.push(rec);
			} catch {
				// 半行/坏行：跳过（账本按行独立，不因一行损坏整体失败）
			}
		}
		if (opts.tail !== undefined && out.length > opts.tail) return out.slice(-opts.tail);
		return out;
	}

	/**
	 * 大结果外置：原文落盘，返回指针。
	 * 同内容 SHA-256 相同 → 天然去重（重复读同一文件不会重复占空间）。
	 */
	externalize(taskId: string, content: string): ArtifactPointer {
		const sha256 = createHash("sha256").update(content).digest("hex");
		const path = this.artifactPath(taskId, sha256);
		if (!existsSync(path)) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content, "utf8");
		}
		return {
			ref: `artifact:${taskId}/${sha256}`,
			bytes: Buffer.byteLength(content, "utf8"),
			sha256,
			preview: content.slice(0, SESSION_DEFAULTS.previewChars),
		};
	}

	/** 按 ref 回灌原文（渐进式披露的「取回来」动作） */
	rehydrate(ref: string): string {
		const m = /^artifact:([^/]+)\/([0-9a-f]{64})$/.exec(ref);
		if (!m) throw new Error(`VULCAN_ARTIFACT_001: 非法 ref ${ref}`);
		const [, taskId, sha] = m as unknown as [string, string, string];
		const path = this.artifactPath(taskId, sha);
		if (!existsSync(path)) throw new Error(`VULCAN_ARTIFACT_002: artifact 不存在 ${ref}`);
		return readFileSync(path, "utf8");
	}

	writeSessionMemory(taskId: string, markdown: string): void {
		const path = this.memoryPath(taskId);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, markdown, "utf8");
	}

	readSessionMemory(taskId: string): string | null {
		const path = this.memoryPath(taskId);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	}
}

/** 把指针渲染成窗口里的 content（模型看到的是这一小段，不是原文） */
export function pointerToContent(p: ArtifactPointer): string {
	return JSON.stringify({ ref: p.ref, bytes: p.bytes, sha256: p.sha256, preview: p.preview });
}

/** 判断一条 content 是否已是指针 */
export function parsePointer(content: string): ArtifactPointer | null {
	try {
		const o = JSON.parse(content) as Partial<ArtifactPointer>;
		if (typeof o.ref === "string" && o.ref.startsWith("artifact:") && typeof o.sha256 === "string") {
			return { ref: o.ref, bytes: o.bytes ?? 0, sha256: o.sha256, preview: o.preview ?? "" };
		}
	} catch {
		// 非 JSON，不是指针
	}
	return null;
}
