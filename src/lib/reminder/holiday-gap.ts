/**
 * 假期表覆盖期自检（需求书 13.12 / FR-48）。
 *
 * - 覆盖期 = **表里最大年份的 12-31**（整年原子覆盖写入，某一年在表里就代表那年完整）。
 *   ⚠️ 不要拿"最后一条假期记录的日期"当覆盖期：一年里最后一条假期通常是 10 月初的国庆，
 *   那样一张完整正确的年度表也会从次年 4 月起被判成"覆盖不足"——警告常年亮着，反而没人看；
 * - 服务端每日检查：覆盖期 < 今天 + **45 天** → 产生一条 `type = holiday_gap` 的事件；
 * - 引用键带覆盖期版本 `coverage:<覆盖期末日>`：表补上后键变了，自检自动重新武装；
 * - 同一覆盖期版本 **30 天内最多产生一条**（服务端节流）；助手回"查了、官方还没发布"也算一次处理。
 */

import { addDays, dayDiff, type DateStr } from "@/lib/time";

export const HOLIDAY_GAP_WINDOW_DAYS = 45;
export const HOLIDAY_GAP_COOLDOWN_DAYS = 30;

export interface HolidayRecord {
  date: DateStr;
  type: "holiday" | "workday";
}

/** 覆盖期 = 表中最大年份的 12-31；空表 → null。 */
export function holidayCoverageEnd(holidays: Iterable<HolidayRecord>): DateStr | null {
  let maxYear = 0;
  for (const h of holidays) {
    const year = Number(h.date.slice(0, 4));
    if (Number.isFinite(year) && year > maxYear) maxYear = year;
  }
  return maxYear > 0 ? `${maxYear}-12-31` : null;
}

export function holidayGapRefKey(coverageEnd: DateStr | null): string {
  return `coverage:${coverageEnd ?? "none"}`;
}

export interface HolidayGapInput {
  coverageEnd: DateStr | null;
  today: DateStr;
  /** 同一覆盖期版本上一次被处理（事件生成或助手回执）的日期；没有传 null */
  lastHandledDate: DateStr | null;
}

/** 覆盖期是否够用（覆盖期末日 ≥ 今天 + 45 天） */
export function holidayCoverageEnough(coverageEnd: DateStr | null, today: DateStr): boolean {
  if (!coverageEnd) return false;
  return coverageEnd >= addDays(today, HOLIDAY_GAP_WINDOW_DAYS);
}

export function holidayGapDue(input: HolidayGapInput): boolean {
  if (holidayCoverageEnough(input.coverageEnd, input.today)) return false;
  if (input.lastHandledDate === null) return true;
  return dayDiff(input.lastHandledDate, input.today) >= HOLIDAY_GAP_COOLDOWN_DAYS;
}

/** 覆盖期的展示文案：带年份才不会看成"今年 12 月 31 日"（跨年时最容易误读） */
export function holidayCoverageText(coverageEnd: DateStr | null): string {
  if (!coverageEnd) return "无数据";
  return `${coverageEnd.slice(0, 4)} 年全年`;
}

/**
 * 首页提示条文案（13.12：**只陈述状态、不给按钮** —— 补表是助手的活，
 * 让用户来催等于把这件事变成他的待办）。
 */
export function holidayGapNotice(coverageEnd: DateStr | null): string {
  const cover = coverageEnd ? `${coverageEnd.slice(0, 4)} 年全年` : "（空表）";
  return `假期表覆盖到 ${cover}，补上之前排期会把春节当训练日；助手每年新安排公布后会自己补。`;
}
