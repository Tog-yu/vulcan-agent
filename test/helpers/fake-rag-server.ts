/**
 * fake-rag-server —— MODULAR-RAG-MCP-SERVER 的**进程内 fake**（测试专用）。
 *
 * 只镜像桥用到的语义（不追求实现复刻）：
 *   - memory_store：写条目 + 治理元数据；id 幂等（同 id 覆盖）
 *   - memory_search：必须非空 query；status=active 且 stale_status="" 才可见
 *     （除非 include_superseded）；naive 关键词计分（命中次数），RRF 语义无关紧要——
 *     测试只断言「排序稳定性」和「可见性」，不打分值本身
 *   - memory_manage：list / mark_stale（code_version XOR entry_ids）/ resolve / clear
 *
 * 断言要的是「桥的翻译是否正确」，不是「RAG 的检索是否聪明」。
 */

import type { McpCallResult, McpClientLike, MemoryClientRole } from "../../src/server/memory/rag-bridge.ts";

interface FakeRecord {
	id: string;
	kind: string;
	text: string;
	status: string;
	scope: string;
	key: string;
	created_at: string;
	verification_status: string;
	code_version: string;
	stale_status: string;
}

function collectionOf(scope: string, key: string): string {
	return `fiat_memory_${scope}_${key}`;
}

function sanitize(key: string): string {
	return key
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.slice(0, 64);
}

/** 记录的 created_at：全局递增 1ms，保证排序稳定性（真服务端时间戳单调） */
let clock = Date.now();

function nextIso(): string {
	clock += 1;
	return new Date(clock).toISOString();
}

export class FakeRagServer {
	/** collection → (entry_id → record) */
	readonly partitions = new Map<string, Map<string, FakeRecord>>();
	/** 记录每次工具调用（断言桥的翻译） */
	readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

	#partition(collection: string): Map<string, FakeRecord> {
		let p = this.partitions.get(collection);
		if (!p) {
			p = new Map();
			this.partitions.set(collection, p);
		}
		return p;
	}

	/** 直接预置一条记录（绕过 store，控制 created_at 等） */
	seed(scope: string, key: string, over: Partial<FakeRecord> & { text: string }): FakeRecord {
		const rec: FakeRecord = {
			id: over.id ?? `m_${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
			kind: over.kind ?? "constraint_decision",
			text: over.text,
			status: over.status ?? "active",
			scope,
			key: sanitize(key),
			created_at: over.created_at ?? nextIso(),
			verification_status: over.verification_status ?? "verified_by_test",
			code_version: over.code_version ?? "",
			stale_status: over.stale_status ?? "",
		};
		this.#partition(collectionOf(scope, sanitize(key))).set(rec.id, rec);
		return rec;
	}

	#hit(r: FakeRecord): Record<string, unknown> {
		return {
			id: r.id,
			kind: r.kind,
			text: r.text,
			score: 0,
			score_type: "rrf_fusion",
			status: r.status,
			scope: r.scope,
			key: r.key,
			created_at: r.created_at,
			verification_status: r.verification_status,
			code_version: r.code_version,
			stale_status: r.stale_status,
		};
	}

	#entry(r: FakeRecord): Record<string, unknown> {
		return {
			id: r.id,
			kind: r.kind,
			text: r.text,
			status: r.status,
			verification_status: r.verification_status,
			code_version: r.code_version,
			stale_status: r.stale_status,
			created_at: r.created_at,
		};
	}

	#search(args: Record<string, unknown>): Record<string, unknown> {
		const scope = String(args.scope ?? "");
		const key = sanitize(String(args.key ?? ""));
		const query = String(args.query ?? "");
		const topK = Number(args.top_k ?? 5);
		const kinds = Array.isArray(args.kinds) ? (args.kinds as string[]) : null;
		const includeSuperseded = args.include_superseded === true;
		const collection = collectionOf(scope, key);
		const all = [...(this.partitions.get(collection)?.values() ?? [])];
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const scored = all
			.filter((r) => (includeSuperseded ? true : r.status === "active" && r.stale_status === ""))
			.filter((r) => !kinds || kinds.includes(r.kind))
			.map((r) => {
				const lower = r.text.toLowerCase();
				const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
				return { r, score };
			});
		const relevant = (terms.length ? scored.filter((s) => s.score > 0) : scored)
			.sort((a, b) => b.score - a.score || b.r.created_at.localeCompare(a.r.created_at))
			.slice(0, Math.min(Math.max(1, topK), 20));
		return {
			hits: relevant.map((s) => ({ ...this.#hit(s.r), score: s.score })),
			collection,
			count: relevant.length,
			degraded: false,
		};
	}

	#manage(args: Record<string, unknown>): Record<string, unknown> {
		const action = String(args.action ?? "");
		const scope = String(args.scope ?? "");
		const key = sanitize(String(args.key ?? ""));
		const collection = collectionOf(scope, key);
		const partition = this.partitions.get(collection) ?? new Map<string, FakeRecord>();

		if (action === "list") {
			const kind = args.kind ? String(args.kind) : null;
			const stale = args.stale_status !== undefined ? String(args.stale_status) : null;
			const entries = [...partition.values()]
				.filter((r) => (kind ? r.kind === kind : true))
				.filter((r) => (stale !== null ? r.stale_status === stale : true));
			return { collection, entries: entries.map((r) => this.#entry(r)), total: entries.length };
		}
		if (action === "mark_stale") {
			const hasVersion = typeof args.code_version === "string" && args.code_version.length > 0;
			const ids = Array.isArray(args.entry_ids) ? (args.entry_ids as string[]) : null;
			if (hasVersion === Boolean(ids && ids.length > 0)) throw new Error("mark_stale requires exactly one selector");
			const targets: FakeRecord[] = [];
			const notFound: string[] = [];
			if (hasVersion) {
				for (const r of partition.values()) {
					if (r.code_version === args.code_version && r.stale_status === "") targets.push(r);
				}
			} else {
				for (const id of ids ?? []) {
					const r = partition.get(id);
					if (r) targets.push(r);
					else notFound.push(id);
				}
			}
			for (const r of targets) r.stale_status = "stale";
			return { marked: targets.length, not_found: notFound, collection };
		}
		if (action === "resolve") {
			const ids = (args.entry_ids as string[]) ?? [];
			const decision = String(args.decision ?? "");
			let resolved = 0;
			const notFound: string[] = [];
			for (const id of ids) {
				const r = partition.get(id);
				if (!r) {
					notFound.push(id);
					continue;
				}
				if (decision === "confirm") r.stale_status = "";
				else if (decision === "retire") {
					r.status = "forgotten";
					r.stale_status = "stale";
				}
				resolved += 1;
			}
			return { resolved, not_found: notFound, collection };
		}
		if (action === "clear") {
			const cleared = partition.size;
			this.partitions.set(collection, new Map());
			return { cleared, collection };
		}
		throw new Error(`unknown action ${action}`);
	}

	/** 生成一个 McpClientLike（读写同库；隔离由桥的后置校验与真服务的分区保证） */
	client(_role: MemoryClientRole): McpClientLike {
		const server = this;
		return {
			async connect() {},
			async close() {},
			async callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult> {
				server.calls.push({ tool: req.name, args: req.arguments });
				try {
					let payload: Record<string, unknown>;
					if (req.name === "memory_store") {
						const scope = String(req.arguments.scope ?? "");
						const key = sanitize(String(req.arguments.key ?? ""));
						const metadata = (req.arguments.metadata ?? {}) as Record<string, unknown>;
						const rec: FakeRecord = {
							id: String(
								req.arguments.entry_id ?? `m_${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
							),
							kind: String(req.arguments.kind ?? ""),
							text: String(req.arguments.text ?? ""),
							status: String(req.arguments.status ?? "active"),
							scope,
							key,
							created_at: nextIso(),
							verification_status: String(metadata.verification_status ?? ""),
							code_version: String(metadata.code_version ?? ""),
							stale_status: "",
						};
						server.#partition(collectionOf(scope, key)).set(rec.id, rec);
						payload = { stored: rec.id, collection: collectionOf(scope, key), superseded: [] };
					} else if (req.name === "memory_search") {
						payload = server.#search(req.arguments);
					} else if (req.name === "memory_manage") {
						payload = server.#manage(req.arguments);
					} else {
						payload = { error: `unknown tool ${req.name}` };
					}
					return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: err instanceof Error ? err.message : String(err),
									error_type: "internal",
								}),
							},
						],
						isError: true,
					};
				}
			},
		};
	}

	/** 桥 deps 的 clientFactory */
	factory(): (cfg: unknown, role: MemoryClientRole) => McpClientLike {
		return (_cfg, role) => this.client(role);
	}

	/** 便捷：某 project 分区里的全部记录 */
	recordsOf(project: string): FakeRecord[] {
		return [...(this.partitions.get(collectionOf("repo", `vulcan-${sanitize(project)}`))?.values() ?? [])];
	}
}
