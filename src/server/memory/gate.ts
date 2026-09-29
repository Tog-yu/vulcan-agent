/**
 * 长期记忆写入门禁（DEV_SPEC §14 P4-1，技术方案 6.1/6.3）。
 *
 * 硬约束（技术方案 6.3）：
 *   - 四类之外不入库（constraint_decision / verified_fix / failure_lesson / user_preference）
 *   - 准入原则：未经验证的模型猜测不作为事实入库——
 *     verification_status 为 unverified → 直接拒绝（observed 也要求真实任务反复观察，此处按方案口径放行）
 *   - 明确不入库：密钥/凭证/令牌（授权非知识）、完整聊天记录、任务中间态
 */

import type { DatabaseSync } from "node:sqlite";

export type MemoryCategory = "constraint_decision" | "verified_fix" | "failure_lesson" | "user_preference";
export type VerificationStatus = "verified_by_test" | "verified_by_human" | "observed" | "unverified";

export interface MemoryCandidate {
	content: string;
	category: MemoryCategory;
	source: string;
	project: string;
	codeVersion?: string;
	verificationStatus: VerificationStatus;
	expiresAt?: number;
}

export interface AdmitResult {
	admitted: boolean;
	id?: string;
	reason?: string;
}

/** 密钥/凭证类内容的特征（技术方案 6.3 排除清单：授权而非知识） */
const SECRET_PATTERNS: RegExp[] = [
	/(sk|pk|api[_-]?key|token|secret|password|passwd|credential)[\s]*[:=]/i,
	/(bearer|basic)[\s]+[a-z0-9._-]{16,}/i,
	/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
	/\b[A-Fa-f0-9]{32,}\b/,
];

/** 门禁拒绝理由（审计可见） */
export type DenyReason =
	| "category-invalid"
	| "unverified-guess"
	| "secret-content"
	| "chat-log-content"
	| "empty-content";

export class MemoryGate {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** 单条准入校验 + 入库；拒绝时返回理由（不抛错——拒绝是正常路径） */
	admit(cand: MemoryCandidate): AdmitResult {
		const reason = MemoryGate.check(cand);
		if (reason) return { admitted: false, reason };

		const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.db
			.prepare(
				`INSERT INTO memories (id, content, category, source, project, code_version, verification_status, expires_at, created_at, last_referenced_at, stale_status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active')`,
			)
			.run(id, cand.content, cand.category, cand.source, cand.project, cand.codeVersion ?? null, cand.verificationStatus, cand.expiresAt ?? null, Date.now());
		return { admitted: true, id };
	}

	/** 纯校验（供离线提炼器预筛，不写库） */
	static check(cand: MemoryCandidate): DenyReason | null {
		if (!cand.content || cand.content.trim().length === 0) return "empty-content";
		if (SECRET_PATTERNS.some((p) => p.test(cand.content))) return "secret-content";
		// 完整聊天记录特征：消息头密集出现（用户:/助手: 每行都有）
		const lines = cand.content.split("\n").filter((l) => l.trim().length > 0);
		const chatLines = lines.filter((l) => /^\s*(用户|user|助手|assistant|assistant:|user:)\s*[:：]/i.test(l)).length;
		if (lines.length >= 4 && chatLines / lines.length > 0.6) return "chat-log-content";
		if (cand.verificationStatus === "unverified") return "unverified-guess";
		return null;
	}
}
