import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
} from "serwist";

/**
 * Service Worker（PWA 外壳）：需求书第 9 章选型 Serwist，对应 NFR-2「手机加到主屏即可」。
 *
 * 边界刻意画得很保守 —— 目标是"装得上、断网有话说"，**不是**离线优先：
 *   ① 预缓存构建产物（`__SW_MANIFEST` 由 @serwist/next 打包时注入）+ 离线兜底页；
 *   ② 带内容哈希的静态资源与图标走缓存优先，其余同源 GET 先网络后缓存；
 *   ③ **接口一律不缓存**（NetworkOnly）—— 这是单用户的健康数据，"看到的就是当下的"比
 *      "断网也能看旧数字"重要；把响应写进 Cache Storage 还会连带把登录态内容留在设备上；
 *   ④ **页面导航也不缓存**（NetworkOnly），断网时由预缓存里的 `/~offline` 顶上。
 *      为什么不缓存 HTML：Next 的服务端渲染结果进了缓存，改完口径后客户端可能还捧着旧的。
 *      等做"离线写入队列"那片时再回来改这一条（那时外壳必须能离线打开）。
 *
 * 接口侧已经按"所有写接口可安全重试"打底（需求书第 7 章：client_id 幂等 / 覆盖语义），
 * 那是离线队列的地基；队列本身（本地 IndexedDB + 恢复后重放 + 乐观 UI）是另一片，
 * 见 docs/开发计划.md §8 第 3 条，**不在这里做**。
 */

declare const self: {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
};

/** 离线兜底页：中间件放行它，所以未登录也能取到，预缓存不会存下一张登录页 */
const OFFLINE_URL = "/~offline";

const runtimeCaching: RuntimeCaching[] = [
  {
    // 构建产物文件名带内容哈希，内容永不变化 —— 命中即用，不必回网络验
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/_next/static/"),
    handler: new CacheFirst({
      cacheName: "app-static",
      plugins: [new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60 })],
    }),
  },
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/icons/"),
    handler: new CacheFirst({
      cacheName: "app-icons",
      plugins: [new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 365 * 24 * 60 * 60 })],
    }),
  },
  {
    // 接口只走网络：断网时让调用方拿到 fetch 失败（各页面已有自己的失败态与重试），
    // 绝不拿缓存里的旧数据冒充"当下"
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"),
    handler: new NetworkOnly(),
  },
  {
    // 页面导航：只走网络。断网时 Serwist 会把 fallbacks 里的离线页挂到这条策略上兜底
    // （fallbacks 不会自建路由，它只往已有的 runtimeCaching 策略里塞回落插件）
    matcher: ({ request }) => request.mode === "navigate",
    handler: new NetworkOnly(),
  },
  {
    // 其余同源 GET（字体等）：先网络后缓存，弱网下略快一点
    matcher: ({ request, sameOrigin }) =>
      sameOrigin && request.method === "GET" && request.destination !== "document",
    handler: new NetworkFirst({
      cacheName: "app-misc",
      plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // 新 SW 立刻接管（不必等所有标签页关掉）—— 单用户应用，不担心"两个版本同时在用"
  skipWaiting: true,
  clientsClaim: true,
  // navigationPreload 保持关闭：Serwist 只调了 enableNavigationPreload()，策略里并不消费
  // event.preloadResponse，开了等于每次导航白发一次重复请求
  runtimeCaching,
  // 注意形状：Serwist 9 的 fallbacks 是 { entries: [...] }，不是 Workbox 那种裸数组
  fallbacks: {
    entries: [
      { url: OFFLINE_URL, matcher: ({ request }) => request.destination === "document" },
    ],
  },
});

serwist.addEventListeners();
