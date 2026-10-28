/**
 * 意图识别（意图路由）最小可跑实现——把「规则优先 / 语义路由 / 阈值兜底」变成可执行的判定路径。
 *
 * 这不是生产代码，是一份说明用 demo：
 *   L1 规则层：正则 + 结构化字段，按序 first-match-wins，0 成本 0 延迟
 *   L2 语义层：意图原型句 + 字符 bigram 余弦（真实可算，不依赖外部服务）
 *              生产把 EmbeddingClassifier 的 score() 换成真 embedding 或走 LLM few-shot 分类器
 *   L3 兜底层：top1 < 阈值 → clarify；margin 太小（两个意图打平）→ clarify；多意图 → 拆分
 *
 * 跑法：node --experimental-strip-types scripts/intent-router.demo.ts
 */

// ---------- 0. 意图标签（枚举，不是自由文本） ----------

const INTENTS = ["code_locate", "ops_scale", "refund_check", "doc_qa"] as const;
type Intent = (typeof INTENTS)[number];

interface RouteDecision {
	/** 最终意图；null = 未能判定，需要澄清 */
	intent: Intent | null;
	/** 命中的层级：rule / semantic / clarify */
	layer: "rule" | "semantic" | "clarify";
	/** 置信度（规则层恒为 1） */
	confidence: number;
	/** 规则 ID 或分类器名，用于追溯与 badcase 归因 */
	reason: string;
	/** 多意图拆分的子结果 */
	subIntents?: Array<{ intent: Intent; span: string }>;
}

// ---------- L1：规则层（确定性，命中即短路） ----------

interface Rule {
	id: string;
	intent: Intent;
	test: (q: string) => boolean;
}

const RULES: Rule[] = [
	// 错误码：PAY-5003 / VULCAN_001 / HTTP-502
	{ id: "err_code", intent: "code_locate", test: (q) => /\b[A-Z][A-Z0-9]{1,9}[-_]\d{3,5}\b/.test(q) },
	// 文件路径 / 符号
	{ id: "file_path", intent: "code_locate", test: (q) => /[\w./-]+\.(ts|tsx|py|go|java|sql)\b/.test(q) },
	// 堆栈
	{ id: "stack_trace", intent: "code_locate", test: (q) => /\bat\s+[\w.$]+\(.*:\d+\)/.test(q) },
	// 运维指标 / 扩容类（这类必须走人工，不能自动改码）
	{ id: "ops_metric", intent: "ops_scale", test: (q) => /(IOPS|CPU|内存|磁盘|扩容|打满|负载)/i.test(q) },
];

function ruleLayer(q: string): RouteDecision | null {
	for (const r of RULES) {
		if (r.test(q)) {
			return { intent: r.intent, layer: "rule", confidence: 1, reason: `rule:${r.id}` };
		}
	}
	return null;
}

// ---------- L2：语义层（可替换实现） ----------

interface Classifier {
	name: string;
	score(q: string): Array<{ intent: Intent; score: number }>;
}

/** 字符 bigram 余弦：够粗糙，但它是真算的，不是假数据 */
function bigrams(s: string): Map<string, number> {
	const t = s.replace(/[\s\p{P}]/gu, "").toLowerCase();
	const m = new Map<string, number>();
	for (let i = 0; i < t.length - 1; i++) {
		const g = t.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (const [k, v] of a) {
		na += v * v;
		const w = b.get(k);
		if (w) dot += v * w;
	}
	for (const v of b.values()) nb += v * v;
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 每个意图 3~4 条原型句（生产环境这里是几百条标注样本 / 或换真 embedding） */
const PROTOTYPES: Record<Intent, string[]> = {
	code_locate: [
		"这段代码在哪里实现的",
		"这个报错的堆栈指向哪个文件",
		"帮我找一下这个函数的定义位置",
		"这个类在哪个仓库哪个分支",
	],
	ops_scale: [
		"服务器资源不够了要不要扩容",
		"数据库负载太高了怎么处理",
		"磁盘空间快满了需要加机器",
		"这个指标告警要不要人工介入",
	],
	refund_check: [
		"用户退款一直没有到账",
		"这笔钱为什么还没退回给客户",
		"退款单状态卡住了帮忙查一下",
		"支付成功但订单显示未退款",
		"用户说退款三天了还没到账",
		"钱一直没退回来怎么办",
		"退款要多久才能到账",
	],
	doc_qa: [
		"这个流程文档怎么写的",
		"发布手册里构建步骤是什么",
		"公司的规范要求是怎么说的",
		"这个接口的文档在哪里",
	],
};

const embeddingClassifier: Classifier = {
	name: "char-bigram-cosine",
	score(q: string) {
		const qv = bigrams(q);
		return INTENTS.map((intent) => {
			const best = Math.max(...PROTOTYPES[intent].map((p) => cosine(qv, bigrams(p))));
			return { intent, score: Number(best.toFixed(4)) };
		}).sort((a, b) => b.score - a.score);
	},
};

// ---------- L3：阈值 + margin + 多意图拆分 ----------

const MIN_CONFIDENCE = 0.34; // 低于此值 → 澄清（这个阈值要按 badcase 调，不是拍的）
const MIN_MARGIN = 0.05; // top1 - top2 小于此值 → 两个意图打平 → 澄清

const MULTI_INTENT_SPLIT = /(，|,|；|;|顺便|另外|同时)/;

function semanticLayer(q: string, clf: Classifier): RouteDecision {
	// 多意图：先拆再分别判（这里用标点/连接词做启发式切分；生产用 LLM 抽子任务）
	const parts = q.split(MULTI_INTENT_SPLIT).map((s) => s.trim()).filter((s) => s.length >= 4);
	if (parts.length >= 2) {
		const subs = parts.map((p) => {
			const ranked = clf.score(p);
			return { intent: ranked[0].intent, span: p };
		});
		const distinct = new Set(subs.map((s) => s.intent));
		if (distinct.size > 1) {
			return {
				intent: null,
				layer: "semantic",
				confidence: 0,
				reason: "multi-intent: 拆成多个子意图，分别路由",
				subIntents: subs,
			};
		}
	}

	const ranked = clf.score(q);
	const [top1, top2] = ranked;
	if (top1.score < MIN_CONFIDENCE) {
		return {
			intent: null,
			layer: "clarify",
			confidence: top1.score,
			reason: `低于阈值 ${MIN_CONFIDENCE}（top1=${top1.intent}:${top1.score}），转澄清/通用兜底`,
		};
	}
	if (top2 && top1.score - top2.score < MIN_MARGIN) {
		return {
			intent: null,
			layer: "clarify",
			confidence: top1.score,
			reason: `top1/top2 打平（${top1.intent}:${top1.score} vs ${top2.intent}:${top2.score}），转澄清`,
		};
	}
	return {
		intent: top1.intent,
		layer: "semantic",
		confidence: top1.score,
		reason: `${clf.name}: top1=${top1.intent} top2=${top2?.intent ?? "-"}`,
	};
}

// ---------- 级联 ----------

export function route(q: string, clf: Classifier = embeddingClassifier): RouteDecision {
	const byRule = ruleLayer(q);
	if (byRule) return byRule; // 命中就短路，不进模型
	return semanticLayer(q, clf);
}

// ---------- 跑例子 ----------

const CASES = [
	"checkout-service 报 PAY-5003 支付超时，堆栈在 PaymentService.java:88",
	"生产库磁盘 IOPS 打满了，需要扩容吗",
	"客户反馈退款三天了钱还没到账",
	"发布手册里第三步是什么",
	"退款一直没到账，顺便帮我看看是不是对账代码的问题",
	"那个……东西好像不太对",
];

console.log("意图路由演示（L1 规则 → L2 语义 → L3 兜底）\n");
for (const q of CASES) {
	const d = route(q);
	const tag = d.intent ?? "（需澄清）";
	console.log(`Q: ${q}`);
	console.log(`   → 层=${d.layer} 意图=${tag} 置信度=${d.confidence} | ${d.reason}`);
	if (d.subIntents) {
		for (const s of d.subIntents) console.log(`     子意图 ${s.intent} ← 「${s.span}」`);
	}
	console.log("");
}
