"use client";

/** 通用小组件（样式都在 globals.css 里，这里只负责结构与状态类）。 */

import type { ReactNode } from "react";

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="sec-title">{children}</div>;
}

export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Pill({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "ok" | "warn" | "alert" | "plain";
}) {
  const cls =
    tone === "ok"
      ? "pill pill-ok"
      : tone === "warn"
        ? "pill pill-warn"
        : tone === "alert"
          ? "pill pill-alert"
          : tone === "plain"
            ? "pill pill-plain"
            : "pill";
  return <span className={cls}>{children}</span>;
}

export function Row({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm">{label}</span>
      <span className="text-right text-sm font-semibold">
        {value}
        {hint ? <span className="muted ml-1 text-xs font-normal">{hint}</span> : null}
      </span>
    </div>
  );
}

export function Divider() {
  return <div className="hr" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm muted">
      {children}
    </div>
  );
}

/** 恢复度色条（FR-3 / 13.9）：< 0.75G 才强调，其余淡出 */
export function RecoveryBar({
  label,
  hoursSince,
  nextDays,
  pct,
  state,
}: {
  label: string;
  hoursSince: number | null;
  nextDays: number | null;
  pct: number;
  state: "none" | "recovering" | "mostly" | "recovered";
}) {
  const color =
    state === "recovering"
      ? "var(--alert)"
      : state === "mostly"
        ? "var(--warn)"
        : state === "recovered"
          ? "var(--ok)"
          : "var(--border)";
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="muted text-xs">
          {hoursSince === null ? "无记录" : `距上次练完 ${hoursSince} 小时`}
          {nextDays !== null && nextDays > 0 ? ` · 距下次轮到 ${nextDays} 天` : ""}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${hoursSince === null ? 0 : Math.max(4, pct)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function ExerciseLine({
  name,
  target,
  meta,
  last,
}: {
  name: string;
  target: string;
  meta?: string;
  last?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium">{name}</div>
        {meta && <div className="muted text-[11.5px]">{meta}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[13px] font-semibold">{target}</div>
        {last && <div className="muted text-[11.5px]">{last}</div>}
      </div>
    </div>
  );
}

/**
 * 底部弹层（规则管理的编辑面板共用）。
 * z-index 30 > 底部 Tab 的 20，弹层盖住一切；点遮罩关闭（与页面内确认层同一套交互习惯）。
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border-t border-border bg-card p-4 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[15px] font-semibold">{title}</div>
          <button type="button" className="tap text-[13px] text-accent" onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 加减步进器（目标组数 / 次数 / 秒数）。min/max 与服务端校验同一档：
 *  组数 1~20、次数与秒数 1~999（13.1 的读数范围校验 + FR-10 的目标组数不能低于已记组数）。 */
export function Stepper({
  label,
  value,
  min = 1,
  max = 999,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`减少${label}`}
        className="grid h-8 w-8 place-items-center rounded-lg border border-border"
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="w-11 text-center text-[12.5px] font-semibold">
        {value}
        <span className="muted ml-0.5 text-[10px] font-normal">{label}</span>
      </span>
      <button
        type="button"
        aria-label={`增加${label}`}
        className="grid h-8 w-8 place-items-center rounded-lg border border-border"
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

/** 点选胶囊（肌群 / 器械 / 读数语义这类"点一下换一个"的选择） */export function Chips<T extends string>({
  options,
  value,
  onChange,
  labelOf,
  multi = false,
  values = [],
}: {
  options: readonly T[];
  value?: T;
  onChange: (v: T) => void;
  labelOf?: (v: T) => string;
  multi?: boolean;
  values?: readonly T[];
}) {
  const label = (v: T) => (labelOf ? labelOf(v) : v);
  const active = (v: T) => (multi ? values.includes(v) : value === v);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={active(option)}
          className={`tap rounded-lg border px-2.5 text-[12.5px] ${
            active(option) ? "border-accent bg-accent-soft font-semibold" : "border-border"
          }`}
          onClick={() => onChange(option)}
        >
          {label(option)}
        </button>
      ))}
    </div>
  );
}
