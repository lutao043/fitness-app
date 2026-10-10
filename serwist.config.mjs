/**
 * Serwist 的构建配置（PWA 外壳，NFR-2 / 需求书第 9 章选型）。
 * 由 `pnpm build:sw` 调用，在 `next build` **之后**单独打一份 Service Worker。
 *
 * ⚠️ 为什么不用 `withSerwist(nextConfig)` 那种 webpack 接法 —— 实测踩过，别再换回去：
 * @serwist/next 9.5.13 的 webpack 插件会把 `.next/server/webpack-runtime.js` 覆盖成
 * webpack 的通用 bootstrap（21KB），Next 定制的 `require("./chunks/" + id)` 加载路径随之丢失
 * （那份只有 1.4KB）。构建**不报错**，但一跑起来 instrumentation 就
 * `Cannot find module './322.js'`，所有渲染路由 500（静态文件正常，所以很像"构架好好的"）。
 * 对照实验做过了：去掉 withSerwist、其余一字不改，生产构建立刻正常 —— 是插件与
 * Next 15.5 server 构建的冲突，不是配置写错了。
 *
 * 所以走 @serwist/next 自带的 **configurator mode**：SW 完全不进 Next 的构建，
 * 由 serwist CLI（内里是 esbuild）独立打包。除了绕开冲突，它还多收两样 webpack 那条路
 * 拿不到的东西 —— 直接 glob 构建产物、以及把**预渲染路由的 HTML** 一并进预缓存
 * （离线兜底页 `/~offline` 正是靠这个进预缓存的，另一条路得手动 additionalPrecacheEntries）。
 *
 * 自动收进预缓存的：`.next/static/**`（映射成 `/_next/...`）、`public/**`
 * （图标与 favicon 在此列）、以及 app/pages 下所有预渲染 .html（映射成各自路由）。
 * 自己的 `sw.js` 在 globIgnores 里排除，不会自我包含。
 */
import { serwist } from "@serwist/next/config";

export default await serwist(
  {
    swSrc: "src/sw.ts",
    swDest: "public/sw.js",

    // ⚠️ 必须关掉预渲染路由的预缓存 —— 这一条是踩出来的，理由值得留档：
    // 默认开着时它会把 / 、/body 、/history 、/settings/* 、/session/plan 这些预渲染 HTML
    // 也塞进预缓存清单。可这些页面**要登录**，预缓存抓它们会被中间件 307 到 /login，
    // Workbox 视为取回失败 → 整个 install 被 reject → **注册被浏览器丢弃**。
    // 而首次注册必然发生在登录页（此时还没登录），所以留着它等于"这个 PWA 永远装不上"。
    // 实测症状：清单声明 100 条、实际只缓存 92 条，差的正好是那 8 个要登录的页面。
    // 关掉之后预缓存只剩公开资源（/_next/static/** 与 public/**），任何登录状态下都抓得到。
    precachePrerendered: false,
    // 关掉预渲染预缓存后，离线兜底页不再自动进来，得手动补一条。
    // revision 每次构建换一个：离线页内容随构建变化，不换客户端会一直用旧的那份。
    additionalPrecacheEntries: [{ url: "/~offline", revision: crypto.randomUUID() }],

    // 目标浏览器必须显式给：不指定时它去问 browserslist，而本仓库没有 browserslist 配置，
    // 于是拿到 "defaults"（chrome64 / safari12 那一档），esbuild 直接报 90 个
    // "Transforming destructuring ... is not supported yet"。
    // 这里对齐 Next 自己的现代档（MODERN_BROWSERSLIST_TARGET），也符合 NFR-2 的目标平台
    // —— SW 只会跑在用户的 Android Chrome 上，没有兼容老浏览器的必要。
    esbuildOptions: { target: ["chrome111", "edge111", "firefox111", "safari16.4"] },
  },
  // nextConfig 传 undefined：让它自己去读 next.config.ts（要拿 distDir / basePath）
  undefined,
  // isDev 显式给 false：这个 helper 只看 NODE_ENV，而 `pnpm build:sw` 是独立进程、
  // NODE_ENV 未必是 production —— 一旦被判成 dev，预缓存清单会被整个跳过（disablePrecacheManifest）
  { isDev: false },
);
