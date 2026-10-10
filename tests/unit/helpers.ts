/**
 * 单测公共设施。
 *
 * 这里有一份**参照实现**（bruteCycleIndex）：按需求书 3.2 伪代码的语义"从锚点逐日走"（含顺延），
 * 只用于对拍 —— 生产实现（算术解）禁止这么写（13.7），但作为独立参照非常适合抓错。
 */

import { addDays } from "@/lib/time";
import type { DateStr } from "@/lib/time";
import { occupies, type CyclePoint, type ScheduleCtx, type ScheduleAnchor, type SlotLike } from "@/lib/schedule";
import { HOLIDAY_SEED_2026, SCHEMES, DEFAULT_SCHEME_ID, type SchemeSeed } from "@/data";

/** 从假期种子构造"只含 type=holiday"的集合（补班日是上班日、要占位，13.7） */
export function holidaySetFrom(seed: Record<string, { type: string }>): Set<DateStr> {
  const set = new Set<DateStr>();
  for (const [date, v] of Object.entries(seed)) {
    if (v.type === "holiday") set.add(date);
  }
  return set;
}

export function makeupWorkdaySetFrom(seed: Record<string, { type: string }>): Set<DateStr> {
  const set = new Set<DateStr>();
  for (const [date, v] of Object.entries(seed)) {
    if (v.type === "workday") set.add(date);
  }
  return set;
}

export const SEED_HOLIDAY_SET = holidaySetFrom(HOLIDAY_SEED_2026);
export const SEED_MAKEUP_SET = makeupWorkdaySetFrom(HOLIDAY_SEED_2026);

export const BASELINE_ANCHOR: ScheduleAnchor = { date: "2026-09-21", position: 0 };

export function cycle4Scheme(): SchemeSeed {
  const scheme = SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID);
  if (!scheme) throw new Error("找不到默认方案 cycle4");
  return scheme;
}

export function cycle4Slots(): SlotLike[] {
  return cycle4Scheme().slots.map((s) => ({
    label: s.label,
    rest: s.rest,
    muscles: s.muscles,
  }));
}

export function makeCtx(opts: {
  anchor?: ScheduleAnchor;
  holidays?: Iterable<DateStr>;
  skips?: Iterable<DateStr>;
  cycleLen?: number;
  /** 循环位点（13.17）：按 (date, 写入顺序) 升序给；同一天多条取最后一条 */
  points?: Iterable<CyclePoint>;
}): ScheduleCtx {
  const slots = cycle4Slots();
  return {
    anchor: opts.anchor ?? BASELINE_ANCHOR,
    holidays: new Set(opts.holidays ?? SEED_HOLIDAY_SET),
    skips: new Set(opts.skips ?? []),
    cycleLen: opts.cycleLen ?? slots.length,
    points: [...(opts.points ?? [])],
  };
}

/** 日期区间（含两端） */
export function dateRange(from: DateStr, to: DateStr): DateStr[] {
  const out: DateStr[] = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/**
 * 参照实现：逐日走，数**半开区间 [min, max) 里的占位日**（语义 = 3.2 伪代码 + skip_day 不占位）。
 * 半开区间这一点很关键：假期当天与"假期后第一个训练日"位次**相同**（9/25~9/27 与 9/28 都是第 4 位），
 * 写成 `[min, max]` 会让假期当天少 1。只准出现在测试里。
 */
export function bruteCycleIndex(date: DateStr, ctx: ScheduleCtx): number {
  const anchor = ctx.anchor.date;
  if (date === anchor) return ctx.anchor.position;
  let idx = ctx.anchor.position;
  if (date > anchor) {
    let d = anchor;
    while (d < date) {
      if (occupies(d, ctx)) idx++;
      d = addDays(d, 1);
    }
    return idx;
  }
  let d = date;
  while (d < anchor) {
    if (occupies(d, ctx)) idx--;
    d = addDays(d, 1);
  }
  return idx;
}
