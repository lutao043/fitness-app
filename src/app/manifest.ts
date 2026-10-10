import type { MetadataRoute } from "next";

/**
 * PWA 清单（NFR-2：目标平台 Android / Chrome，"手机加到主屏即可"）。
 *
 * 走 `app/manifest.ts` 这条元数据路由，而不是往 `public/` 塞一份静态 json：
 * 它和 layout 的 metadata 一样是"代码里的一份声明"，字段有类型、写错能被 typecheck 抓住。
 * 生成路径固定是 `/manifest.webmanifest` —— 中间件放行名单里就是照这个名字留的（NFR-4）。
 *
 * ⚠️ 生效前提是**安全上下文**（HTTPS 或 localhost）：纯 HTTP 直访时手机浏览器会忽略清单、
 * 只当普通书签处理；等 HTTPS（DDNS + DNS-01 证书，需求书第 9 章第 9 条）落地
 * 才真正"装上主屏"。本机 `pnpm build && pnpm start` 打开 127.0.0.1:3210 是安全上下文，可以先验。
 *
 * 图标三张与 `public/icons/` 下的实际文件一一对应，尺寸也必须是文件真实尺寸
 * （tests/unit/pwa.test.ts 会读 PNG 头逐个核对，改图标记得重跑 `pnpm icons:generate`）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // id 一经确定就不该再改：Android 靠它认"同一个 App"，换了等于换了个应用（旧的留在桌面上）
    id: "/",
    name: "健身助手",
    short_name: "健身助手",
    description: "自托管的个人健身应用：排期 + 训练记录 + 体重",
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    // standalone：从主屏打开时不显示浏览器地址栏，与"像个 App"的预期一致
    display: "standalone",
    // 启动画面底色取浅色态背景（与 layout 里 viewport.themeColor 的浅色一致）
    background_color: "#f5f6f8",
    theme_color: "#f5f6f8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // maskable：满幅背景 + 哑铃缩进安全区，被系统裁成圆形 / 水滴 / 方圆形都不缺角
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
