"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 页面层级（需求书第 5 章）：Tab 层只有这 4 个页面，互相平切、底部 Tab 常驻；
// 子页层（历史详情、训练会话…）只留「返回」一个出口，不显示底部 Tab 栏。
const TABS = [
  { href: "/", label: "今日", icon: "today" },
  { href: "/history", label: "记录", icon: "history" },
  { href: "/body", label: "身体", icon: "body" },
  { href: "/settings", label: "我的", icon: "settings" },
] as const;

function TabIcon({ name, active }: { name: string; active: boolean }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: active ? 2.2 : 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "today":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      );
    case "history":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 19V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
    case "body":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 19h16M6 19V9M10 19V5M14 19v-7M18 19v-4" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5" />
        </svg>
      );
  }
}

export function BottomTabs() {
  const pathname = usePathname();
  const visible = TABS.some((t) => t.href === pathname);
  if (!visible) return null;

  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-[480px] items-stretch justify-around">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] font-medium ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <TabIcon name={t.icon} active={active} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
