/**
 * 暂停 / 停练的判定（FR-38、13.8）。
 *
 * 停练了几个**训练日**（只数"该练而没练"的日子，休息日与法定节假日不算）——
 * 重锚询问（FR-38：停练 ≥3 个训练日先问一句再改）与 13.8 的欠账升级都用它。
 */

import { addDays, type DateStr } from "@/lib/time";
import { isTrainingDay } from "./cycle";
import type { ScheduleCtx, SlotLike } from "./types";

/** 重锚询问阈值：≥3 个训练日无记录（FR-38）。 */
export const REANCHOR_ASK_AFTER_TRAINING_DAYS = 3;

/**
 * lastActivity = 最近一次训练 / workout 打卡 / 顺延的日子（顺延也算"有动作"，
 * 否则连续顺延会被当成停练，天天问重锚）。
 */
export function trainingDaysMissed(
  today: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  lastActivity: DateStr | null,
  maxDays = 400,
): number {
  if (lastActivity === null) return 0;
  let count = 0;
  let d = addDays(today, -1);
  for (let i = 0; i < maxDays; i++) {
    if (d <= lastActivity) break;
    if (isTrainingDay(d, ctx, slots)) count++;
    d = addDays(d, -1);
  }
  return count;
}

export function shouldAskReanchor(trainingDaysMissedCount: number): boolean {
  return trainingDaysMissedCount >= REANCHOR_ASK_AFTER_TRAINING_DAYS;
}
