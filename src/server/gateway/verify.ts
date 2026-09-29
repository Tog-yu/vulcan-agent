/**
 * Webhook 签名校验（DEV_SPEC §14 P1-4）。
 *
 * HMAC-SHA256，密钥按 source 隔离；timing-safe 比较。
 * 硬约束：query string 传 token 一律拒绝（PLAN-TRACKING 硬约束 2）。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookSource = "alert" | "meegle" | "approval";

export interface SecretProvider {
	getSecret(source: WebhookSource): string;
}

export type VerifyResult =
	| { ok: true }
	| { ok: false; status: 401 | 403; reason: string };

function hexEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * 校验签名。签名头：X-Vulcan-Signature = hex(HMAC-SHA256(secret, rawBody))。
 * 签名缺失 → 401；签名错误或 URL 带 token 参数 → 403。
 */
export function verifyWebhook(
	source: WebhookSource,
	rawBody: Buffer,
	headers: Record<string, string | string[] | undefined>,
	url: URL,
	secrets: SecretProvider,
): VerifyResult {
	// 硬约束：query string 传 token 一律拒绝
	for (const key of url.searchParams.keys()) {
		if (/token|key|secret|signature|sig/i.test(key)) {
			return { ok: false, status: 403, reason: `URL query 携带敏感参数被拒绝：${key}` };
		}
	}

	const raw = headers["x-vulcan-signature"];
	const signature = Array.isArray(raw) ? raw[0] : raw;
	if (!signature) {
		return { ok: false, status: 401, reason: "缺少 X-Vulcan-Signature 头" };
	}

	const secret = secrets.getSecret(source);
	if (!secret) {
		return { ok: false, status: 403, reason: `source ${source} 未配置密钥` };
	}

	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	if (!hexEqual(signature.toLowerCase(), expected)) {
		return { ok: false, status: 403, reason: "签名不匹配" };
	}
	return { ok: true };
}

/** 供测试与本地模拟投递生成合法签名 */
export function signPayload(source: WebhookSource, rawBody: Buffer, secret: string): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}
