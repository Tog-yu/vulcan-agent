/**
 * verification_status 证据强度表（冲突裁定用，高者胜）。
 *
 * 独立成文件：它是裁定逻辑（MemoryStore.arbitrateConflict）的**纯数据判据**，
 * 与传输层无关，测试直接对着它断言。
 */

export const VERIFICATION_STRENGTH: Readonly<Record<string, number>> = {
	verified_by_test: 3,
	verified_by_human: 3,
	observed: 2,
	unverified: 1,
};
