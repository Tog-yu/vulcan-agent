/**
 * meegle 工单服务（技术方案 · 7.2）
 *
 * 通道组合：Webhook 收增量（gateway 已接入）+ Open API 补能力。
 * Open API 口径（官方文档）：RESTful，X-PLUGIN-TOKEN / X-USER-KEY 鉴权，
 * X-IDEM-UUID 幂等（写接口），单 token 单接口 15 QPS 限流。
 */

import type { AppConfig } from "../config/index.ts";

export interface MeegleDeps {
	config: AppConfig;
	env: NodeJS.ProcessEnv;
}

export class MeegleService {
	readonly #deps: MeegleDeps;

	constructor(deps: MeegleDeps) {
		this.#deps = deps;
	}

	#headers(idemUuid?: string): Record<string, string> {
		const h: Record<string, string> = {
			"content-type": "application/json",
			"x-plugin-token": this.#deps.env[this.#deps.config.meegle.pluginTokenEnv] ?? "",
			"x-user-key": this.#deps.env[this.#deps.config.meegle.userKeyEnv] ?? "",
		};
		if (idemUuid) h["x-idem-uuid"] = idemUuid;
		return h;
	}

	/** 回查工单详情（Webhook payload 只带概要） */
	async getWorkItem(projectKey: string, workItemId: string): Promise<unknown> {
		const url = `${this.#deps.config.meegle.baseUrl}/open_api/${projectKey}/work_item/get`;
		const res = await fetch(url, {
			method: "POST",
			headers: this.#headers(),
			body: JSON.stringify({ work_item_id: workItemId }),
		});
		if (!res.ok) throw new Error(`meegle get_work_item failed: ${res.status}`);
		return res.json();
	}

	/** 回写：流转节点 / 补备注 / 关联 PR（写接口，带幂等 UUID） */
	async transitionNode(projectKey: string, workItemId: string, nodeKey: string, idemUuid: string): Promise<unknown> {
		const url = `${this.#deps.config.meegle.baseUrl}/open_api/${projectKey}/work_item/transition_node`;
		const res = await fetch(url, {
			method: "POST",
			headers: this.#headers(idemUuid),
			body: JSON.stringify({ work_item_id: workItemId, node_key: nodeKey }),
		});
		if (!res.ok) throw new Error(`meegle transition_node failed: ${res.status}`);
		return res.json();
	}
}
