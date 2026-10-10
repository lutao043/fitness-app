/**
 * 启动钩子（需求书第 9 章第 12 条）：定时任务统一在这里注册，
 * **不要写在路由模块顶层**（standalone 下路由按需加载，写在里面可能根本不执行；dev 下 HMR 又会重复注册）。
 *
 * 写法照 Next 官方文档：只在这里做"按运行时"的条件引入 —— `NEXT_RUNTIME` 会被 webpack
 * 按运行时内联，edge 那份编译不会把 Node 专用模块打进去（否则会报 Can't resolve 'fs' / 'node:path'）。
 * 真正的注册逻辑在 `instrumentation-node.ts`（Node 运行时专用）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 注意必须**调用**子模块的 register（只 import 不会执行任何注册逻辑）
    const { register } = await import("./instrumentation-node");
    await register();
  }
}
