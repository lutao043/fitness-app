/**
 * 重锚询问（需求书 FR-38 / 13.8）：**禁止自动重锚**，先问一句，确认了才改。
 *
 * - 停练 ≥ 3 个训练日 → 推送「停了几天了，要不要把循环重锚？」；
 * - 用户**拒绝** → 排期不变，且本次暂停期内（到出现新的训练记录为止）不再重复问；
 * - 13.8 的第 3 天顺延 → 先弹重锚询问：接受 = 以今天重锚、欠账清零；拒绝 = 照写 skip_day 并升级提示。
 */

import type { DateStr } from "@/lib/time";

export interface ReanchorGateInput {
  /** 停练的训练日数（schedule/pause.ts 的 trainingDaysMissed） */
  trainingDaysMissed: number;
  /** 最近一次"拒绝"重锚建议的日期；没有传 null */
  lastRejectedAt: DateStr | null;
  /** 最近一次训练 / workout 打卡的日期；没有传 null */
  lastRecordDate: DateStr | null;
}

/** 拒绝后到出现新训练记录为止，不再重复问（FR-38）。 */
export function reanchorAskSuppressed(
  lastRejectedAt: DateStr | null,
  lastRecordDate: DateStr | null,
): boolean {
  if (lastRejectedAt === null) return false;
  return lastRecordDate === null || lastRejectedAt >= lastRecordDate;
}

export function shouldProposeReanchor(input: ReanchorGateInput, threshold = 3): boolean {
  if (input.trainingDaysMissed < threshold) return false;
  return !reanchorAskSuppressed(input.lastRejectedAt, input.lastRecordDate);
}
