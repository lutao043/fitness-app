import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "离线 · 健身助手",
};

/**
 * 离线兜底页（NFR-2）：断网时 Service Worker 用它顶上，代替浏览器的"无法访问此网站"。
 *
 * 刻意做成**不碰数据库、不读登录态**的静态页：
 * ① 它要在预缓存里躺一份（next.config.ts 的 additionalPrecacheEntries），构建时就渲染定稿；
 * ② 中间件放行 `/~offline`（见 src/middleware.ts），否则预缓存抓取时会被重定向到登录页，
 *    缓存里存下的就是一张登录页 —— 断网时点开 App 看到"请登录"比看到"你离线了"糟得多。
 *
 * 这一片只做外壳，所以这里如实告诉用户"现在看不了"：
 * 离线记账（本地队列 + 恢复后重放）是另一片，见 docs/开发计划.md §8 第 3 条。
 */
export default function OfflinePage() {
  return (
    <main className="mt-16">
      <div className="card text-center">
        <svg
          width="44"
          height="44"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="muted mx-auto"
          aria-hidden="true"
        >
          <path d="M2 8.8a16 16 0 0 1 20 0M5 12.5a11 11 0 0 1 14 0M8.5 16.2a6 6 0 0 1 7 0" />
          <path d="M12 20h.01" />
          <path d="M3 3l18 18" />
        </svg>

        <h1 className="mt-3 text-lg font-semibold">网络不通</h1>
        <p className="muted mt-2 text-sm">
          现在连不上服务器。检查一下网络，或者等回到有信号的地方再打开。
        </p>
        <p className="muted mt-2 text-sm">已经记下的数据都在服务器上，不会因为断网丢掉。</p>

        <form action="/" className="mt-5">
          <button type="submit" className="btn btn-primary btn-block">
            重试
          </button>
        </form>
      </div>
    </main>
  );
}
