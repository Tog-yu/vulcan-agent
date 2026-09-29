/**
 * 通知服务（DEV_SPEC §14 P2-7，技术方案 8.3）。
 *
 * 职责边界：
 *   - 转人工审批时推送飞书卡片（@ 责任人 + 人工上下文包）
 *   - 责任人路由：工单 owner → 代码 owner → 值班/团队负责人，逐级兜底
 *   - 超时升级：未裁决超 timeout 后路由到下一级（escalate()，周期触发）
 *
 * 外部不可用（webhook 未配置/推送失败）→ 显式降级：不静默丢消息，落 WARN 日志由调用方告警。
 */

export interface ManualContext {
	ticketId: string;
	taskId: string;
	/** 变更意图 */
	intent: string;
	/** 关键 diff 摘要 */
	diffSummary: string;
	/** 影响范围 */
	impactScope: string;
	/** 验证证据摘要 */
	evidenceSummary: string;
	/** 建议处置与理由 */
	reasons: string[];
}

export interface OwnerChain {
	/** 工单 owner（来自 meegle 工单负责人） */
	ticketOwner: string;
	/** 代码 owner（按文件/blame 匹配的路由表） */
	codeOwner: string;
	/** 团队负责人（兜底） */
	teamLead: string;
	/** 值班（最末兜底，可选） */
	onDuty?: string;
}

export interface NotifierDeps {
	/** 飞书机器人 webhook 地址；null = 通知禁用（显式降级） */
	larkWebhook: string | null;
	fetchImpl?: typeof fetch;
	now?: () => number;
	onWarn?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface EscalationState {
	ticketId: string;
	/** 当前生效的负责人 */
	currentOwner: string;
	/** 已完成的通知时间 */
	notifiedAt: number;
	/** 升级阶梯（递减） */
	chain: string[];
}

/** 责任人路由阶梯：工单 owner → 代码 owner → 团队负责人 → 值班 */
export function ownerChainOf(chain: OwnerChain): string[] {
	const list = [chain.ticketOwner, chain.codeOwner, chain.teamLead];
	if (chain.onDuty) list.push(chain.onDuty);
	return [...new Set(list.filter((x) => x && x.length > 0))];
}

export class Notifier {
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly deps: NotifierDeps;
	/** ticketId → 升级状态 */
	private readonly escalations = new Map<string, EscalationState>();

	constructor(deps: NotifierDeps) {
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.now = deps.now ?? Date.now;
	}

	/** 发飞书卡片；返回是否实际送达（false = 禁用或失败，调用方需告警） */
	async sendManualReviewCard(owner: string, ctx: ManualContext): Promise<boolean> {
		if (!this.deps.larkWebhook) {
			this.deps.onWarn?.("飞书 webhook 未配置，通知禁用（显式降级）", { ticketId: ctx.ticketId });
			return false;
		}
		const card = {
			msg_type: "interactive",
			card: {
				elements: [
					{
						tag: "div",
						text: {
							tag: "lark_md",
							content: `**待人工审批** @${owner}\n**意图**：${ctx.intent}\n**diff**：${ctx.diffSummary}\n**影响面**：${ctx.impactScope}\n**证据**：${ctx.evidenceSummary}\n**理由**：${ctx.reasons.join("; ")}`,
						},
					},
				],
				header: { title: { tag: "plain_text", content: `Vulcan 审批 ${ctx.ticketId}` } },
			},
		};
		try {
			const res = await this.fetchImpl(this.deps.larkWebhook, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(card),
			});
			if (!res.ok) {
				this.deps.onWarn?.("飞书推送失败", { ticketId: ctx.ticketId, status: res.status });
				return false;
			}
			return true;
		} catch (err) {
			this.deps.onWarn?.("飞书推送异常", { ticketId: ctx.ticketId, error: (err as Error).message });
			return false;
		}
	}

	/** 登记待裁决审批（通知第一级责任人） */
	async registerForApproval(chain: OwnerChain, ctx: ManualContext, timeoutMs: number): Promise<void> {
		const levels = ownerChainOf(chain);
		const first = levels[0];
		this.escalations.set(ctx.ticketId, { ticketId: ctx.ticketId, currentOwner: first, notifiedAt: this.now(), chain: levels });
		await this.sendManualReviewCard(first, ctx);
	}

	/**
	 * 周期触发：超过 timeoutMs 未裁决 → 升级到阶梯下一级并重新通知。
	 * 已到最末级则不再升级（等待人工/超时失败由审批链路兜底）。
	 * 返回本次升级后的负责人；无需升级返回 null。
	 */
	async escalateIfExpired(ticketId: string, timeoutMs: number, ctx: ManualContext): Promise<string | null> {
		const st = this.escalations.get(ticketId);
		if (!st) return null;
		if (this.now() - st.notifiedAt < timeoutMs) return null;
		const idx = st.chain.indexOf(st.currentOwner);
		if (idx < 0 || idx >= st.chain.length - 1) return null;
		const next = st.chain[idx + 1];
		st.currentOwner = next;
		st.notifiedAt = this.now();
		await this.sendManualReviewCard(next, ctx);
		return next;
	}

	/** 裁决回流后清理升级状态 */
	resolve(ticketId: string): void {
		this.escalations.delete(ticketId);
	}
}
