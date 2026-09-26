/**
 * 会话管理（技术方案 · 五）
 *
 * 持续保存对话消息、工具记录和执行进度，重新进入时加载历史。
 * 运行期支撑机制，不是任务结束后的单独步骤。
 * 框架阶段：内存实现；持久化（SQLite，对齐 fiat_agent 的 append-only event store 设计）后续填充。
 */

export type SessionRole = "user" | "assistant" | "tool";

export interface SessionEntry {
	role: SessionRole;
	content: string;
	toolName?: string;
	at: number;
}

export class SessionStore {
	readonly #sessions = new Map<string, SessionEntry[]>();

	append(sessionId: string, entry: Omit<SessionEntry, "at">): void {
		const list = this.#sessions.get(sessionId) ?? [];
		list.push({ ...entry, at: Date.now() });
		this.#sessions.set(sessionId, list);
	}

	load(sessionId: string): SessionEntry[] {
		return [...(this.#sessions.get(sessionId) ?? [])];
	}
}
