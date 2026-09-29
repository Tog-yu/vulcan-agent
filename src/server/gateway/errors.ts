/** gateway 错误类型：HTTP 层据此映射状态码，不向客户端泄漏内部细节 */

export class NormalizeError extends Error {
	readonly status = 422;
}

export class PayloadTooLargeError extends Error {
	readonly status = 413;
}
