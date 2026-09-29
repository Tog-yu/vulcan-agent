import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		/**
		 * 超时放宽到 3 分钟：沙箱环境（WorkBuddy 注入的 node-language-shim，
		 * 逐文件同步 IPC 读模块）下 pi-ai/typebox 模块图求值需 ~70-90s；
		 * 干净环境（env -u NODE_OPTIONS）下整个套件 <1s。见 DEV_SPEC §14 备注。
		 */
		testTimeout: 180_000,
		hookTimeout: 180_000,
	},
});
