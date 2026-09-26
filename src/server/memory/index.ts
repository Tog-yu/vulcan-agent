/**
 * 记忆写入与召回（技术方案 · 六）
 *
 * 从任务过程及结果中筛选、校验有价值的项目知识或有效经验，再写入长期记忆。
 * 后续任务按权限和相关性召回。
 * 口径：会话记录保存"发生了什么"，长期记忆保留"哪些知识值得以后复用"。
 *   不将全部历史消息自动当作记忆，也不将模型未经验证的猜测直接作为事实。
 * 框架阶段：内存实现；后续对接 MODULAR-RAG-MCP-SERVER / OpenClaw。
 */

export interface MemoryRecord {
	id: string;
	/** 记忆内容（已筛选、已校验） */
	content: string;
	/** 权限范围：哪些团队 / 项目可见 */
	scopes: string[];
	sourceTaskId: string;
	createdAt: number;
	/** 校验状态：未经验证的猜测不得入库 */
	verified: boolean;
}

export class MemoryStore {
	readonly #records: MemoryRecord[] = [];

	/** 写入前强制校验：verified=false 直接拒绝（对齐技术方案"不将未经验证的猜测作为事实"） */
	write(rec: Omit<MemoryRecord, "id" | "createdAt">): MemoryRecord | null {
		if (!rec.verified) return null;
		const full: MemoryRecord = { ...rec, id: crypto.randomUUID(), createdAt: Date.now() };
		this.#records.push(full);
		return full;
	}

	/** 按权限 + 相关性召回（相关性打分后续接 embedding 检索） */
	recall(query: string, scopes: string[], topK = 5): MemoryRecord[] {
		const kw = query.toLowerCase();
		return this.#records
			.filter((r) => r.scopes.some((s) => scopes.includes(s)))
			.map((r) => ({ r, score: kw && r.content.toLowerCase().includes(kw) ? 1 : 0 }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)
			.map((x) => x.r);
	}
}
