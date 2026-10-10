"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SerwistProvider } from "@serwist/next/react";
import { useEffect, useState } from "react";

/**
 * dev 专用：把浏览器里可能残留的 Service Worker 注销掉。
 *
 * prod 与 dev 共用 `127.0.0.1:3210` 这一个 origin —— 按交付说明验完 PWA（`pnpm build && pnpm start`）
 * 再回来跑 `pnpm dev` 时，上一轮注册的 SW 还在，而且 dev 也会把 `public/sw.js` 这份构建产物当静态
 * 文件发出来，于是它会接管 dev 页面、把 HMR 的中间产物缓存住：改了不生效，还找不到原因。
 * 生产构建里 `process.env.NODE_ENV` 是常量，这段会被整段摇掉。
 */
function DevServiceWorkerCleanup() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .then((results) => {
        if (results.some(Boolean)) console.info("[dev] 已注销残留的 Service Worker");
      })
      .catch(() => {});
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 单用户自托管：重连即拉、失败重试一次就够（局域网环境）
            retry: 1,
            refetchOnWindowFocus: true,
            // 切 Tab 时 30s 内直接吃缓存（写操作各自 invalidateQueries 兜底刷新），
            // 避免每次导航都重新拉一轮接口造成的切换顿挫
            staleTime: 30_000,
          },
        },
      }),
  );
  return (
    <SerwistProvider
      swUrl="/sw.js"
      // dev 下不注册：`pnpm build:sw` 只在构建时跑，dev 根本没有新鲜的 SW 可注册；
      // 顺手也躲开"被上一轮的旧 SW 接管"（DevServiceWorkerCleanup 兜另一半）。
      disable={process.env.NODE_ENV !== "production"}
    >
      <DevServiceWorkerCleanup />
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SerwistProvider>
  );
}
