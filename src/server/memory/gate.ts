/**
 * 长期记忆写入门禁（DEV_SPEC §14 P4-1，技术方案 6.1/6.3）。
 *
 * 存储后端切换为 RAG 后，门禁职责收敛为**纯校验**（不再触达任何存储）：
 *   - 四类之外不入库（constraint_decision / verified_fix / failure_lesson / user_preference）
 *   - 准入原则：未经验证的模型猜测不作为事实入库——
 *     verification_status 为 unverified → 直接拒绝（observed 也要求真实任务反复观察，此处按方案口径放行）
 *   - 明确不入库：密钥/凭证/令牌（授权非知识）、完整聊天记录、任务中间态
 *   - 正文超长拒绝而非截断（RAG 侧 max_text_chars=300，两侧口径一致）
 *
 * 通过校验的候选由 MemoryStore.admit 走 RAG 写入（rag-bridge.store）。
 */

export type MemoryCategory = "constraint_decision" | "verified_fix" | "failure_lesson" | "user_preference";
export type VerificationStatus = "verified_by_test" | "verified_by_human" | "observed" | "unverified";

/** 与 RAG config/settings.yaml memory.write.max_text_chars 一致（契约：两侧各持一份，漂移即测试失败） */
export const MAX_MEMORY_TEXT_CHARS = 300;

export interface MemoryCandidate {
	content: string;
	category: MemoryCategory;
	source: string;
	project: string;
	codeVersion?: string;
	verificationStatus: VerificationStatus;
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
	| "empty-content"
	| "content-too-long";

export class MemoryGate {
	/** 纯校验（不触达存储）；拒绝时返回理由——拒绝是正常路径，不抛错 */
	static check(cand: MemoryCandidate): DenyReason | null {
		if (!cand.content || cand.content.trim().length === 0) return "empty-content";
		if (cand.content.length > MAX_MEMORY_TEXT_CHARS) return "content-too-long";
		if (SECRET_PATTERNS.some((p) => p.test(cand.content))) return "secret-content";
		// 完整聊天记录特征：消息头密集出现（用户:/助手: 每行都有）
		const lines = cand.content.split("\n").filter((l) => l.trim().length > 0);
		const chatLines = lines.filter((l) => /^\s*(用户|user|助手|assistant|assistant:|user:)\s*[:：]/i.test(l)).length;
		if (lines.length >= 4 && chatLines / lines.length > 0.6) return "chat-log-content";
		if (cand.verificationStatus === "unverified") return "unverified-guess";
		return null;
	}
}
