/**
 * 循环位算术解（需求书 13.7；对拍基线 docs/排期对拍基线.md，1762 天 0 处不一致）。
 *
 *   index(date) = 锚点位次 ± 区间内「占位日」的个数
 *
 * 占位日 = 非假期且非顺延。**禁止 while 从锚点逐日推**：锚点可能在几年前，
 * 历史回看、统计、恢复度都会频繁调用；这里用"日期间隔 − 区间内假期数 − 区间内顺延数"的算术解法，
 * 复杂度只跟假期表/顺延条数有关，跟目标日期离锚点多远无关。
 *
 * 两个最容易写错的点（原型对拍抓出来过）：
 * 1. **补班日是占位的** —— 不能按"假期表里存在这个键"去减（构造 ctx 时只放 type=holiday）；
 * 2. 区间取半开的 `[min, max)` —— 两端都"含锚点那端、不含更远那端"，所以恒减 max 那一端的占位。
 */

import { addDays, dayDiff, type DateStr } from "@/lib/time";
import type { CyclePoint, ScheduleAnchor, ScheduleCtx, SlotLike } from "./types";

/** 该日生效的"底"：最后一个不晚于它的循环位点；没有位点就是锚点（行为与 v1.19 一致）。 */
export function baseAt(date: DateStr, ctx: ScheduleCtx): ScheduleAnchor {
  const points: readonly CyclePoint[] = ctx.points ?? [];
  let best: CyclePoint | null = null;
  for (const p of points) {
    if (p.date > date) continue;
    // 同一天多条取最后一条（== 也覆盖），与"生效锚点 = 最新一条"同源
    if (!best || p.date >= best.date) best = p;
  }
  return best ?? ctx.anchor;
}

/** 该日是否占循环位：非假期、未顺延。 */
export function occupies(date: DateStr, ctx: ScheduleCtx): boolean {
  return !ctx.holidays.has(date) && !ctx.skips.has(date);
}

/**
 * 闭区间 [lo, hi] 内占位日的个数（lo/hi 顺序无关）。
 * 只遍历假期表与顺延表（一年几十条），不随区间长度增长。
 */
export function occupyingCount(lo: DateStr, hi: DateStr, ctx: ScheduleCtx): number {
  let from = lo;
  let to = hi;
  if (from > to) [from, to] = [to, from];
  const total = dayDiff(from, to) + 1;
  let off = 0;
  for (const h of ctx.holidays) {
    if (h >= from && h <= to) off++;
  }
  for (const s of ctx.skips) {
    if (s >= from && s <= to && !ctx.holidays.has(s)) off++; // 假期与顺延同一天只减一次
  }
  return total - off;
}

/**
 * 日历日 → 循环位（不取模，可正可负）。
 * 底 = 最后一个不晚于该日的循环位点（13.17），没有位点就是锚点 —— 所以位点只影响它的当天及以后，
 * 之前的日子仍按锚点 / 更早的位点算（"今天加练"不能回头改写过去几天的排期）。
 * 支持 `date < anchor.date`（历史回看、统计、恢复度都要算过去某天该练什么）。
 */
export function cycleIndex(date: DateStr, ctx: ScheduleCtx): number {
  const base = baseAt(date, ctx);
  if (date === base.date) return base.position;

  const forward = date > base.date;
  const lo = forward ? base.date : date;
  const hi = forward ? date : base.date;
  // 区间 [min, max)：含锚点那端、不含更远那端 → 减 max 那一端的占位（goal 日本身不计入步数）
  const steps = occupyingCount(lo, hi, ctx) - (occupies(hi, ctx) ? 1 : 0);
  return forward ? base.position + steps : base.position - steps;
}

/** 循环位取模到 [0, cycleLen)：负数也要落到合法区间（锚点在未来的手滑场景）。 */
export function slotIndexAt(date: DateStr, ctx: ScheduleCtx): number {
  const len = ctx.cycleLen > 0 ? ctx.cycleLen : 1;
  return ((cycleIndex(date, ctx) % len) + len) % len;
}

export function slotOf<T extends SlotLike>(
  date: DateStr,
  ctx: ScheduleCtx,
  slots: readonly T[],
): T | null {
  if (slots.length === 0) return null;
  return slots[slotIndexAt(date, ctx)] ?? null;
}

export function partOf(date: DateStr, ctx: ScheduleCtx, slots: readonly SlotLike[]): string {
  return slotOf(date, ctx, slots)?.label ?? "";
}

export function isHolidayDay(date: DateStr, ctx: ScheduleCtx): boolean {
  return ctx.holidays.has(date);
}

export function isSkippedDay(date: DateStr, ctx: ScheduleCtx): boolean {
  return ctx.skips.has(date);
}

/** 训练日 = 非法定节假日 且 循环位不是「休」（13.6 的断签判定、FR-31 的提醒都读它）。 */
export function isTrainingDay(
  date: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
): boolean {
  if (isHolidayDay(date, ctx)) return false;
  const slot = slotOf(date, ctx, slots);
  return !!slot && !slot.rest;
}

/**
 * 从 from（含）起，找第一个「轮到目标循环位」的训练日 —— 用于 13.9 的「距下次轮到 X 天」。
 * 这是有界前向搜索（上限 maxDays），不是 13.7 禁止的"从锚点逐日推"：
 * 步数由循环长度 + 连续假期/顺延的长度决定，与锚点新旧无关。
 */
export function nextDateOfSlotIndex(
  from: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  targetIndex: number,
  maxDays = 120,
): DateStr | null {
  let d = from;
  for (let i = 0; i < maxDays; i++) {
    const slot = slotOf(d, ctx, slots);
    if (occupies(d, ctx) && slot && !slot.rest && slotIndexAt(d, ctx) === targetIndex) return d;
    d = addDays(d, 1);
  }
  return null;
}

/** 从 from（含）起，找第一个覆盖了目标大部位（肌群）的训练日。 */
export function nextDateOfGroup(
  from: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  group: string,
  groupOf: (muscle: string) => string,
  maxDays = 120,
): DateStr | null {
  let d = from;
  for (let i = 0; i < maxDays; i++) {
    const slot = slotOf(d, ctx, slots);
    if (occupies(d, ctx) && slot && !slot.rest) {
      const groups = (slot.muscles ?? []).map(groupOf);
      if (groups.includes(group)) return d;
    }
    d = addDays(d, 1);
  }
  return null;
}

/**
 * 从 from（含）起，找第一个训练日（含部位名）—— 加练后的"接下来练什么"用它（13.17）。
 * 顺延（skip）日跳过：那天的部位会顺延到下一个训练日再补（13.8）。
 */
export function nextTrainingOn(
  from: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  maxDays = 60,
): { date: DateStr; label: string } | null {
  let d = from;
  for (let i = 0; i < maxDays; i++) {
    if (occupies(d, ctx) && isTrainingDay(d, ctx, slots)) {
      const slot = slotOf(d, ctx, slots);
      if (slot) return { date: d, label: slot.label };
    }
    d = addDays(d, 1);
  }
  return null;
}
