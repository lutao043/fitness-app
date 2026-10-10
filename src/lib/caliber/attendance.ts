/**
 * 出勤率口径（13.4 / 原型记录页统计卡）。
 *
 * 出勤率 = 有训练或打卡的天数 / 计划训练日数。
 * 分母**已扣除休息日与法定节假日**（补班日占循环位、照算计划日）；
 * 分子 = 训练会话（doing/done）∪ workout 打卡的去重天数 —— 打卡算出勤，不等于有明细。
 * 休日/节假日练了同样计入分子（出勤事实就是出勤），展示层按需封顶 100%。
 */

import { addDays, type DateStr } from "@/lib/time";
import { isTrainingDay } from "@/lib/schedule/cycle";
import type { ScheduleCtx, SlotLike } from "@/lib/schedule/types";

export interface AttendanceStats {
  /** 窗口内的计划训练日数（分母） */
  plannedDays: number;
  /** 窗口内有训练或打卡的天数（分子） */
  attendedDays: number;
}

export function attendanceStats(
  today: DateStr,
  days: number,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  attended: ReadonlySet<DateStr>,
): AttendanceStats {
  let plannedDays = 0;
  let attendedDays = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(today, -i);
    if (attended.has(d)) attendedDays++;
    if (isTrainingDay(d, ctx, slots)) plannedDays++;
  }
  return { plannedDays, attendedDays };
}
