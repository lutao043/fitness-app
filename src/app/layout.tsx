import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { BottomTabs } from "@/components/bottom-tabs";
import { ConfirmProvider } from "@/components/confirm";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: "健身助手",
  description: "自托管的个人健身应用：排期 + 训练记录 + 体重",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "健身助手" },
  // 图标全部由 scripts/generate-icons.mjs 从一段 SVG 生成（`pnpm icons:generate`），
  // 不要手改 public/icons 下的 PNG。写成一组是**按能力回落**：现代浏览器取 SVG（缩放不糊），
  // 老客户端取 PNG，最后是 favicon.ico 兜底。
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    ],
    // iOS 加到主屏（NFR-2 的目标平台是 Android，这条是顺手兼容）
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0f13" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <ToastProvider>
            <ConfirmProvider>
              <div className="shell">{children}</div>
              <BottomTabs />
            </ConfirmProvider>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
