/**
 * 连续记录天数 streak（需求书 13.6）。
 *
 * - 定义：**连续有记录日**。"有记录" = 当天有体重记录 ∪ 训练记录 ∪ **workout 打卡**
 *   （补剂打卡**不参与** —— 它每天例行发生，计入会让训练日几乎不可能断签）；
 * - 断签判定**只针对训练日**：训练日完全无记录 → 断签；「休」日与法定节假日不参与判定
 *   （既不要求也不断签）；当天已顺延（skip）同样不算断签；
 * - 今天还没记录不算断签（早上打开不会看到它清零）。
 */

import { addDays, type DateStr } from "@/lib/time";
import { isHolidayDay, isTrainingDay, type ScheduleCtx, type SlotLike } from "@/lib/schedule";

export interface StreakInput {
  today: DateStr;
  ctx: ScheduleCtx;
  slots: readonly SlotLike[];
  /** "有记录"的判定：体重 ∪ 训练 ∪ workout 打卡（补剂打卡不要传进来） */
  hasRecord: (date: DateStr) => boolean;
  /** 回溯上限（默认 400 天），防止异常数据下的无界循环 */
  maxDays?: number;
}

/** 返回连续记录天数（不含今天没记录的情况）与是否已断（今天之前的第一个训练日无记录）。 */
export function streak(input: StreakInput): number {
  const maxDays = input.maxDays ?? 400;
  let days = 0;
  let d = input.today;
  for (let i = 0; i < maxDays; i++) {
    if (isHolidayDay(d, input.ctx) || !isTrainingDay(d, input.ctx, input.slots)) {
      d = addDays(d, -1); // 休日 / 法定节假日：不参与判定
      continue;
    }
    if (input.ctx.skips.has(d)) {
      d = addDays(d, -1); // 已顺延：不断签，也不计为记录日
      continue;
    }
    if (input.hasRecord(d)) {
      days++;
      d = addDays(d, -1);
      continue;
    }
    if (d === input.today) {
      d = addDays(d, -1); // 今天还没记录：不算断签，但也不计数
      continue;
    }
    break; // 训练日无记录且未顺延 → 断
  }
  return days;
}
