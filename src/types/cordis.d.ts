/**
 * cordis v4 类型兜底（仅类型层，运行时仍用 node_modules/cordis 的真实实现）。
 *
 * 背景：npm cordis@4.0.0-rc.10 的 lib/*.d.ts 使用无扩展名相对导入
 * （`export * from './context'`），在 moduleResolution=Node16 下类型解析失败
 * （TS2834），skipLibCheck 静默吞掉 → `Module '"cordis"' has no exported
 * member 'Context'`。tsgo 同样受影响；moduleResolution=bundler 下正常。
 *
 * 这里按 cordis/src 源码手写 vulcan 用到的最小类型面。等 cordis 官方修复
 * d.ts 扩展名（或项目迁移 moduleResolution=bundler）后可删除本文件。
 *
 * 参考源：node_modules/cordis/src/{context,service,registry,fiber}.ts
 * （与 DeepSeek Harness vendor/cordis 同源，v4 API）。
 */

declare module "cordis" {
	/** cordis 服务基类：super(ctx, name) 后实例注册到 ctx.<name>，随 fiber 卸载自动移除 */
	export abstract class Service {
		constructor(ctx: unknown, name: string);
		/** 服务名 */
		name: string;
	}

	/** cordis 插件 fiber：可 await（加载完成/失败），可 dispose（逆序卸载） */
	export interface Fiber extends PromiseLike<Fiber> {
		dispose(): Promise<void> | void;
	}

	/** effect 注册返回的解绑函数（fiber 卸载时逆序调用） */
	export type Disposable = () => void;

	/** cordis 上下文（proxy：服务读经 reflect 层，插件须显式 inject 声明依赖） */
	export class Context {
		constructor();
		/** 加载一个插件（函数/类/{name,inject,apply} 对象），返回 thenable fiber */
		plugin(plugin: unknown, ...args: unknown[]): PromiseLike<unknown>;
		/** 依赖就绪后运行回调（等价 plugin({ inject, apply: callback })） */
		inject(deps: string[], callback: (ctx: Context) => unknown): PromiseLike<unknown>;
		/** 生命周期 effect：注册 disposer，fiber 卸载时逆序调用 */
		effect(fn: () => Disposable): void;
		/** 事件监听（'dispose' 等），返回解绑函数 */
		on(event: string, listener: (...args: never[]) => void): Disposable;
		/** 根 fiber：dispose 逆序卸载整棵插件树 */
		fiber: { dispose(): Promise<void> | void };
	}

	/** cordis 插件形态（对象形态：name + inject + apply，对齐 DSH 插件约定） */
	export interface CordisPluginShape {
		name?: string;
		inject?: string[];
		apply(ctx: Context, config?: unknown): unknown;
	}
}
