/**
 * rag-bridge —— Vulcan 长期记忆与 RAG server（MODULAR-RAG-MCP-SERVER）之间的**存储桥**。
 *
 * 参考 fiat-agent-pi `memory/store.ts` 的四条边界职责，全部收口在本文件：
 *
 *   ① **snake_case ↔ camelCase 的唯一转换点**。散着转换 = 漏一处静默丢字段。
 *   ② **分区（scope/key）的唯一注入点**。调用方只给 project（如 "svc/auth"），
 *      分区名由本模块拼装：scope 固定 "repo"，key = `vulcan-<消毒后 project>`。
 *   ③ **后置校验（第 ③ 道隔离防线）**：返回体里的 scope/key 必须与本侧身份逐字相等，
 *      不等即丢弃 + 记 violation，**不抛**。
 *   ④ **降级与熔断的落点**：检索失败返回 degraded 空结果（永不抛），驱动断路器。
 *
 * 双客户端结构（与 fiat 同款）：**写客户端是 JS 私有字段 `#write`**，对外只暴露
 * 检索/管理方法 —— 会话侧拿不到写通道的引用。读写连接**独立降级**：RAG server
 * 半故障（读挂了写还在）不会被压成「整体不可用」。
 */

import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type CircuitSnapshot, MemoryCircuitBreaker } from "./circuit.ts";
import { createTransport, type RagMcpConfig } from "./rag-transport.ts";

/** Vulcan 记忆的四种类别（与 RAG 白名单逐一同名，无需翻译） */
export type MemoryKind = "constraint_decision" | "verified_fix" | "failure_lesson" | "user_preference";

/** RAG 侧分区 scope 固定 repo（项目级记忆） */
export const MEMORY_SCOPE = "repo" as const;
/** 分区 key 前缀：与 fiat 写同一个 RAG server 时不会共占一个分区 */
export const MEMORY_KEY_PREFIX = "vulcan";

// ─────────────────────────────────────────────────────────────────────────────
// 分区与 id（本模块是唯一拼装点）
// ─────────────────────────────────────────────────────────────────────────────

/** project → 合法分区 key（RAG 侧要求 ^[a-z0-9_-]{1,64}$） */
export function sanitizeKey(project: string): string {
	const sanitized = project
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 58); // 58 + "vulcan-"(7) ≤ 64
	return sanitized.length > 0 ? sanitized : "default";
}

/** project → 完整分区 key（含前缀） */
export function partitionKey(project: string): string {
	return `${MEMORY_KEY_PREFIX}-${sanitizeKey(project)}`;
}

/** 条目 id：RAG 侧固定形态 `m_<32 hex>`（BM25 前缀删除要求定长） */
export function generateEntryId(): string {
	return `m_${randomBytes(16).toString("hex")}`;
}

export const ENTRY_ID_PATTERN = /^m_[0-9a-f]{32}$/;

// ─────────────────────────────────────────────────────────────────────────────
// wire 类型（对端返回体）
// ─────────────────────────────────────────────────────────────────────────────

/** 对端 hits[] 元素（MemoryHit.to_dict()，schema v2 含治理三字段） */
export interface WireHit {
	id?: unknown;
	kind?: unknown;
	text?: unknown;
	score?: unknown;
	score_type?: unknown;
	status?: unknown;
	scope?: unknown;
	key?: unknown;
	created_at?: unknown;
	verification_status?: unknown;
	code_version?: unknown;
	stale_status?: unknown;
}

/** 域形态的命中条目 */
export interface MemoryHit {
	id: string;
	kind: MemoryKind;
	text: string;
	score: number;
	scoreType: string;
	status: string;
	scope: string;
	key: string;
	createdAt: string;
	verificationStatus: string;
	codeVersion: string;
	staleStatus: string;
}

export interface RagSearchOutcome {
	hits: MemoryHit[];
	collection: string;
	/** true = 降级产物（存储不可达 / 熔断中），不代表「没有记忆」 */
	degraded: boolean;
	error?: string;
	/** 被后置校验丢弃的越界条目（隔离违规证据） */
	isolationViolations: Array<{ id: string; reason: string }>;
}

export interface ManageListEntry {
	id: string;
	kind: MemoryKind;
	text: string;
	status: string;
	verificationStatus: string;
	codeVersion: string;
	staleStatus: string;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 客户端抽象（测试注入 fake 用）
// ─────────────────────────────────────────────────────────────────────────────

export interface McpCallResult {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

export interface McpClientLike {
	connect(): Promise<void>;
	callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
	close(): Promise<void>;
}

export type MemoryClientRole = "read" | "write";

/** 一次 callTool 的解析结果：**isError 也要试解 payload**（对端降级路径带 payload 返回） */
interface ParsedCall {
	payload: Record<string, unknown> | null;
	text: string;
	isError: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function wireToHit(raw: WireHit): MemoryHit {
	return {
		id: asString(raw.id),
		kind: asString(raw.kind) as MemoryKind,
		text: asString(raw.text),
		score: asNumber(raw.score),
		scoreType: asString(raw.score_type, "unknown"),
		status: asString(raw.status),
		scope: asString(raw.scope),
		key: asString(raw.key),
		createdAt: asString(raw.created_at),
		verificationStatus: asString(raw.verification_status),
		codeVersion: asString(raw.code_version),
		staleStatus: asString(raw.stale_status),
	};
}

/** 后置校验（fail-closed）：返回体 scope/key 必须与本侧身份逐字相等，否则丢弃 */
export function assertOwned(hit: { scope?: string; key?: string }, expectedKey: string): string | null {
	if (!hit.scope || !hit.key) return "返回体缺少 scope/key，无法比对（fail-closed）";
	if (hit.scope !== MEMORY_SCOPE) return `scope 越界：期望 ${MEMORY_SCOPE}，实际 ${hit.scope}`;
	if (hit.key !== expectedKey) return `key 越界：期望 ${expectedKey}，实际 ${hit.key}`;
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 桥本体
// ─────────────────────────────────────────────────────────────────────────────

export interface RagMemoryBridgeDeps {
	rag: RagMcpConfig;
	/** 记忆总开关（关掉 = 检索降级为空、写入被拒） */
	enabled?: boolean;
	/** 客户端工厂。**会被调用两次**（read / write）——测试靠 role 区分 mock */
	clientFactory?: (cfg: RagMcpConfig, role: MemoryClientRole) => McpClientLike;
	/** 检索侧断路器。缺省自建（threshold=5 / cooldown=120s） */
	circuit?: MemoryCircuitBreaker;
	timeoutMs?: number;
	log?: (level: "warn" | "error" | "info", message: string, detail?: Record<string, unknown>) => void;
}

export class RagMemoryBridge {
	readonly #deps: RagMemoryBridgeDeps;
	/** **写通道**：私有字段。调用方拿不到它 —— 结构性隔离 */
	#write?: McpClientLike;
	#read?: McpClientLike;
	#connectRead?: Promise<boolean>;
	#connectWrite?: Promise<boolean>;
	#circuit?: MemoryCircuitBreaker;

	constructor(deps: RagMemoryBridgeDeps) {
		this.#deps = deps;
		this.#circuit = deps.circuit;
	}

	get enabled(): boolean {
		return this.#deps.enabled ?? true;
	}

	private get timeoutMs(): number {
		return this.#deps.timeoutMs ?? this.#deps.rag.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	circuit(): MemoryCircuitBreaker {
		this.#circuit ??= new MemoryCircuitBreaker();
		return this.#circuit;
	}

	// ── 连接（读写独立降级，永不抛）──

	private client(role: MemoryClientRole): McpClientLike {
		if (this.#deps.clientFactory) return this.#deps.clientFactory(this.#deps.rag, role);
		const client = new Client({ name: `vulcan-memory-${role}`, version: "0.0.1" });
		const transport = createTransport(this.#deps.rag);
		return {
			connect: () => client.connect(transport),
			callTool: async (req) => (await client.callTool(req)) as McpCallResult,
			close: () => client.close(),
		};
	}

	#ensureRead(): Promise<boolean> {
		if (!this.#connectRead) {
			this.#connectRead = (async () => {
				try {
					this.#read = this.client("read");
					await this.#read.connect();
					return true;
				} catch (err) {
					this.#deps.log?.("warn", `记忆读通道不可用：${err instanceof Error ? err.message : String(err)}`);
					return false;
				}
			})();
		}
		return this.#connectRead;
	}

	#ensureWrite(): Promise<boolean> {
		if (!this.#connectWrite) {
			this.#connectWrite = (async () => {
				try {
					this.#write = this.client("write");
					await this.#write.connect();
					return true;
				} catch (err) {
					this.#deps.log?.("warn", `记忆写通道不可用：${err instanceof Error ? err.message : String(err)}`);
					return false;
				}
			})();
		}
		return this.#connectWrite;
	}

	async close(): Promise<void> {
		for (const c of [this.#read, this.#write]) {
			try {
				await c?.close();
			} catch {
				// 拆除失败不升级成错误
			}
		}
	}

	// ── 调用（一个地方做「超时 + payload 提取」）──

	async #call(client: McpClientLike, name: string, args: Record<string, unknown>): Promise<ParsedCall> {
		const result = await withTimeout(
			client.callTool({ name, arguments: args }),
			this.timeoutMs,
			`记忆 MCP ${name} 超时（${this.timeoutMs}ms）`,
		);
		const text = (result.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		let payload: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
		} catch {
			payload = null; // 非 JSON（SDK 层 schema 报错是纯文本）
		}
		return { payload, text, isError: result.isError === true };
	}

	#requireRead(): McpClientLike {
		if (!this.#read) throw new Error("rag-bridge: 读通道未连接");
		return this.#read;
	}

	#requireWrite(): McpClientLike {
		if (!this.#write) throw new Error("rag-bridge: 写通道未连接");
		return this.#write;
	}

	// ── 读：检索（读通道唯一公开语义）──

	/** 检索本分区。**永不抛**；降级返回 degraded=true 空结果 */
	async search(
		project: string,
		query: string,
		opts: { kinds?: MemoryKind[]; topK?: number } = {},
	): Promise<RagSearchOutcome> {
		const key = partitionKey(project);
		const empty = (degraded: boolean, error?: string): RagSearchOutcome => ({
			hits: [],
			collection: `fiat_memory_${MEMORY_SCOPE}_${key}`,
			degraded,
			...(error ? { error } : {}),
			isolationViolations: [],
		});

		if (!this.enabled) return empty(true, "记忆未启用");
		const breaker = this.circuit();
		if (!breaker.allow()) return empty(true, "记忆检索已熔断（冷却中），直接返回空结果");
		if (!(await this.#ensureRead())) {
			breaker.recordFailure();
			return empty(true, "记忆读通道不可用（connect 失败）");
		}

		let parsed: ParsedCall;
		try {
			parsed = await this.#call(this.#requireRead(), "memory_search", {
				query,
				scope: MEMORY_SCOPE,
				key,
				...(opts.kinds ? { kinds: [...opts.kinds] } : {}),
				top_k: opts.topK ?? 5,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			breaker.recordFailure();
			return empty(true, `记忆检索失败：${msg}`);
		}

		const payload = parsed.payload;
		if (!payload) {
			breaker.recordFailure();
			return empty(true, `记忆检索失败：返回体无法解析（${parsed.text.slice(0, 120)}）`);
		}
		if (payload.degraded === true) {
			breaker.recordFailure(); // 对端降级 = 熔断器的触发信号
			return empty(true, `记忆存储不可用（degraded）：${asString(payload.error)}`);
		}
		if (parsed.isError) {
			breaker.recordFailure();
			return empty(true, `记忆检索失败：${asString(payload.error, parsed.text.slice(0, 120))}`);
		}

		breaker.recordSuccess();

		// 第 ③ 道防线：后置校验。越界即丢弃，不抛。
		const rawHits = Array.isArray(payload.hits) ? (payload.hits as WireHit[]) : [];
		const hits: MemoryHit[] = [];
		const isolationViolations: RagSearchOutcome["isolationViolations"] = [];
		for (const raw of rawHits) {
			const hit = wireToHit(raw);
			const violation = assertOwned(hit, key);
			if (violation) {
				isolationViolations.push({ id: hit.id, reason: violation });
				continue;
			}
			// stale 是待复核状态，不该进对话（RAG read path 已滤，此处双保险）
			if (hit.staleStatus !== "" || hit.status !== "active") continue;
			hits.push(hit);
		}
		if (isolationViolations.length > 0) {
			this.#deps.log?.("error", `记忆检索发现 ${isolationViolations.length} 条越界结果，已丢弃`, {
				violations: isolationViolations,
			});
		}
		return {
			hits,
			collection: asString(payload.collection, `fiat_memory_${MEMORY_SCOPE}_${key}`),
			degraded: false,
			isolationViolations,
		};
	}

	// ── 写（私有通道；门禁之后的唯一出口）──

	/** 写入一条记忆。返回 ok=false 时带原因（不抛——策略性失败逐条可见） */
	async store(args: {
		project: string;
		entryId: string;
		kind: MemoryKind;
		text: string;
		verificationStatus?: string;
		codeVersion?: string;
	}): Promise<{ ok: boolean; stored?: string; error?: string }> {
		if (!this.enabled) return { ok: false, error: "记忆未启用" };
		if (!ENTRY_ID_PATTERN.test(args.entryId))
			return { ok: false, error: `entry id 形态非法（必须 m_<32hex>）：${args.entryId}` };
		if (!(await this.#ensureWrite())) return { ok: false, error: "记忆写通道不可用（connect 失败）" };

		const key = partitionKey(args.project);
		let parsed: ParsedCall;
		try {
			parsed = await this.#call(this.#requireWrite(), "memory_store", {
				scope: MEMORY_SCOPE,
				key,
				kind: args.kind,
				text: args.text,
				entry_id: args.entryId,
				status: "active",
				metadata: {
					...(args.verificationStatus ? { verification_status: args.verificationStatus } : {}),
					...(args.codeVersion ? { code_version: args.codeVersion } : {}),
				},
			});
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		const payload = parsed.payload;
		if (payload && (payload.dense_ok === false || payload.sparse_ok === false)) {
			return {
				ok: false,
				error: `半写（dense_ok=${String(payload.dense_ok)} sparse_ok=${String(payload.sparse_ok)}）`,
			};
		}
		if (parsed.isError || !payload || typeof payload.stored !== "string") {
			return {
				ok: false,
				error: parsed.isError ? asString(payload?.error, parsed.text.slice(0, 160)) : "memory_store 返回体缺少 stored",
			};
		}
		return { ok: true, stored: payload.stored };
	}

	// ── 管理面（生命周期；全部分区约束）──

	/** memory_manage。返回 payload；失败返回 null + 记日志（管理面失败由调用方决定语义） */
	async manage(project: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		if (!this.enabled) return null;
		if (!(await this.#ensureWrite())) {
			this.#deps.log?.("warn", "记忆管理面不可用：写通道 connect 失败");
			return null;
		}
		try {
			const parsed = await this.#call(this.#requireWrite(), "memory_manage", {
				scope: MEMORY_SCOPE,
				key: partitionKey(project),
				...args,
			});
			if (parsed.isError || !parsed.payload) {
				this.#deps.log?.("warn", `memory_manage 失败：${asString(parsed.payload?.error, parsed.text.slice(0, 120))}`);
				return null;
			}
			return parsed.payload;
		} catch (err) {
			this.#deps.log?.("warn", `memory_manage 失败：${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/** 枚举本分区条目（无查询词的召回 / 生命周期判定都用它） */
	async listEntries(
		project: string,
		opts: { kind?: MemoryKind; staleStatus?: string; limit?: number } = {},
	): Promise<ManageListEntry[]> {
		const payload = await this.manage(project, {
			action: "list",
			...(opts.kind ? { kind: opts.kind } : {}),
			...(opts.staleStatus !== undefined ? { stale_status: opts.staleStatus } : {}),
			limit: opts.limit ?? 200,
		});
		const entries = Array.isArray(payload?.entries) ? (payload.entries as Array<Record<string, unknown>>) : [];
		return entries.map((e) => ({
			id: asString(e.id),
			kind: asString(e.kind) as MemoryKind,
			text: asString(e.text),
			status: asString(e.status),
			verificationStatus: asString(e.verification_status),
			codeVersion: asString(e.code_version),
			staleStatus: asString(e.stale_status),
			createdAt: asString(e.created_at),
		}));
	}

	/** 复核：confirm 恢复 active，retire 下线（status=forgotten）。返回实际生效条数 */
	async resolve(project: string, entryIds: string[], decision: "confirm" | "retire"): Promise<number> {
		if (entryIds.length === 0) return 0;
		const payload = await this.manage(project, { action: "resolve", entry_ids: entryIds, decision });
		return asNumber(payload?.resolved);
	}

	/** 按显式 id 标 stale（冲突裁定落败方 / 超期待复核） */
	async markStaleByIds(project: string, entryIds: string[]): Promise<number> {
		if (entryIds.length === 0) return 0;
		const payload = await this.manage(project, { action: "mark_stale", entry_ids: entryIds });
		return asNumber(payload?.marked);
	}

	/** 物理清空本分区（评测 reset）。返回清除条数 */
	async clearPartition(project: string): Promise<number> {
		const payload = await this.manage(project, { action: "clear" });
		return asNumber(payload?.cleared);
	}

	status(): { enabled: boolean; read: string; write: string; circuit: CircuitSnapshot } {
		return {
			enabled: this.enabled,
			read: this.#read ? "ready" : "idle",
			write: this.#write ? "ready" : "idle",
			circuit: this.circuit().snapshot(),
		};
	}
}

/** withTimeout：超时抛错（Promise 竞速） */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}
