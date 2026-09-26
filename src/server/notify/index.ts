/**
 * 通知服务（技术方案 · 8.3）
 *
 * 人工审批触发时通知责任人：飞书卡片 @ + 可选邮件。
 * 超时逐级升级：责任人 → 团队负责人（升级阶梯配置后续填充）。
 */

export interface ManualApprovalNotice {
	ticketId: string;
	ref: string;
	applicant: string;
	reasons: string[];
}

export interface NotifyDeps {
	env: NodeJS.ProcessEnv;
	larkWebhookEnv: string;
}

export class NotifyService {
	readonly #deps: NotifyDeps;

	constructor(deps: NotifyDeps) {
		this.#deps = deps;
	}

	async sendManualApprovalNeeded(notice: ManualApprovalNotice): Promise<void> {
		const webhook = this.#deps.env[this.#deps.larkWebhookEnv];
		if (!webhook) {
			console.warn("[notify] LARK_WEBHOOK 未配置，降级为日志输出");
			console.info("[notify] manual approval needed:", notice);
			return;
		}
		// TODO: 飞书卡片消息（@ 责任人 + 上下文包链接）；先实现最简文本 webhook
		const text = [
			"🔔 待人工审批",
			`审批单: ${notice.ticketId}`,
			`关联: ${notice.ref}`,
			`申请人: ${notice.applicant}`,
			`转人工原因: ${notice.reasons.join("; ")}`,
		].join("\n");
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ msg_type: "text", content: { text } }),
		});
		if (!res.ok) throw new Error(`lark notify failed: ${res.status}`);
	}
}
