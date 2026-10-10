/**
 * 加练的循环顺延（需求书 13.17）—— 纯函数，不碰数据库、不碰 React。
 *
 * 非训练日（循环位「休」或法定节假日）真练了 = **加练**。它对排期的两条影响：
 *   ① 今天没休的「休」顺延到明天：`cycle_point(T+1) = 今天这一位`
 *      （假期加练没有这条 —— 法定节假日本来就不占循环位，没有"休息"要补，13.7）；
 *   ② 加练部位的下一次排期从循环里去掉：在"已合入 ①"的新排期上，从明天起第一次轮到该部位的
 *      那天 D，循环位改成"它的下一位"（后面的日子顺次前移一格）。
 *
 * 加练**不写 skip_day、不产生欠账**（13.8）—— 它是"今天多练了一次"，不是"今天没练"。
 * 位点只影响当日及以后（13.7），**不许用追加锚点实现**：锚点会把过去几天的排期一起改写。
 */

import { addDays, type DateStr } from "@/lib/time";
import { nextDateOfSlotIndex, nextTrainingOn, occupies, slotIndexAt, slotOf } from "./cycle";
import type { CyclePoint, ScheduleCtx, SlotLike } from "./types";

export interface ExtraTrainingInput {
  /** 加练当天（非训练日） */
  date: DateStr;
  /** 加练部位的循环位下标（槽位在方案里的 position） */
  slotPosition: number;
  slots: readonly SlotLike[];
  /** 加练前的排期 ctx（含已有位点） */
  ctx: ScheduleCtx;
  /** 找"下一次排期"的前向搜索上限（默认 400 天，够跨过任何假期表空档） */
  maxDays?: number;
}

/**
 * 算出这次加练要写入的循环位点（1~2 条，只返回"还不在库里"的那几条）。
 * 调用方负责落库（幂等键 = ref_session_id）与撤销。
 */
export function extraTrainingPoints(input: ExtraTrainingInput): CyclePoint[] {
  const { date, slotPosition, slots, ctx } = input;
  const len = ctx.cycleLen > 0 ? ctx.cycleLen : slots.length || 1;
  const out: CyclePoint[] = [];
  const working: CyclePoint[] = [...(ctx.points ?? [])];

  // ① 今天没休的「休」顺延到明天（假期加练没有这一条）
  if (!ctx.holidays.has(date)) {
    const restPoint: CyclePoint = { date: addDays(date, 1), position: slotIndexAt(date, ctx) };
    if (!hasSamePoint(working, restPoint)) out.push(restPoint);
    working.push(restPoint);
  }

  // ② 加练部位的下一次排期 → 换成它的下一位（在新排期上找 D）
  const d = nextDateOfSlotIndex(
    addDays(date, 1),
    { ...ctx, points: working },
    slots,
    slotPosition,
    input.maxDays ?? 400,
  );
  if (d) {
    const succ: CyclePoint = { date: d, position: (slotPosition + 1) % len };
    if (!hasSamePoint(working, succ)) out.push(succ);
  }
  return out;
}

function hasSamePoint(points: readonly CyclePoint[], p: CyclePoint): boolean {
  return points.some((x) => x.date === p.date && x.position === p.position);
}

export interface ExtraShiftSummary {
  /** 今天没休的「休」落在哪天（假期加练 = null） */
  restDate: DateStr | null;
  /** 接下来第一场训练练什么 */
  nextTraining: { date: DateStr; label: string } | null;
}

/**
 * 加练生效后的提示（今日页"顺延到哪 + 下次练什么"）—— 必须在位点落库**之后**、
 * 用**新的** ctx 调它，提示才与排期一致（踩坑第 26 条同源：不允许页面自己算一份）。
 */
export function extraShiftSummary(input: {
  /** 加练当天 */
  date: DateStr;
  /** 已含加练位点的排期 ctx */
  ctx: ScheduleCtx;
  slots: readonly SlotLike[];
  /** 这一天加练前是不是循环位「休」（假期加练 = false，没有休息要补） */
  deferredRest: boolean;
  maxDays?: number;
}): ExtraShiftSummary {
  const maxDays = input.maxDays ?? 60;
  let restDate: DateStr | null = null;
  if (input.deferredRest) {
    let d = addDays(input.date, 1);
    for (let i = 0; i < maxDays; i++) {
      const slot = slotOf(d, input.ctx, input.slots);
      if (occupies(d, input.ctx) && slot?.rest) {
        restDate = d;
        break;
      }
      d = addDays(d, 1);
    }
  }
  const from = restDate ? addDays(restDate, 1) : addDays(input.date, 1);
  return { restDate, nextTraining: nextTrainingOn(from, input.ctx, input.slots, maxDays) };
}
