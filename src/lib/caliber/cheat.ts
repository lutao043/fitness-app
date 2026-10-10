/**
 * 放纵餐（需求书 3.4 / FR-25）。**只是提醒，不是规定**，文案永远只陈述事实。
 *
 * - 频率：N 天一轮（默认 8 天 = 两个训练循环）；锚点 = 最近一次真的吃了的那天；
 * - 建议日撞**上班日**（周一~周五，**含周末补班日**）→ 顺延到之后最近的**非补班周末**；
 * - 落在周末时：优先挑休息日 / 假期那天，周六优先；
 *   若周末两天都要训练 → 饭照吃，**当天训练顺延**（不是把饭挪走）；
 * - 锚点长期没更新（一直没报"吃了"）时先按间隔往前追平，避免显示一个已经过去的建议日。
 */

import { addDays, dayDiff, isWeekend, type DateStr } from "@/lib/time";

export const DEFAULT_CHEAT_INTERVAL_DAYS = 8;

export interface CheatInput {
  /** 最近一次真的吃了的那天 */
  anchorDate: DateStr;
  intervalDays?: number;
  today: DateStr;
  /** 是否法定节假日（type=holiday） */
  isHoliday: (d: DateStr) => boolean;
  /** 是否补班日（type=workday）—— 补班日算上班日 */
  isMakeupWorkday: (d: DateStr) => boolean;
  /** 是否训练日（含"周末两天都要训练"的判定） */
  isTrainingDay: (d: DateStr) => boolean;
  maxIterations?: number;
}

/** 上班日 = 非周末（或补班）且非法定节假日 */
export function isWorkingDay(
  d: DateStr,
  opts: { isHoliday: (d: DateStr) => boolean; isMakeupWorkday: (d: DateStr) => boolean },
): boolean {
  if (opts.isHoliday(d)) return false;
  if (opts.isMakeupWorkday(d)) return true;
  return !isWeekend(d);
}

export function cheatNext(input: CheatInput): DateStr {
  const step = Math.max(1, Math.round(input.intervalDays ?? DEFAULT_CHEAT_INTERVAL_DAYS));
  const guardMax = input.maxIterations ?? 400;
  let guard = 0;
  let d = addDays(input.anchorDate, step);

  // ① 追平：锚点 + 间隔可能落在过去（长期没报"吃了"）
  while (d < input.today && guard++ < guardMax) d = addDays(d, step);

  // ② 撞上班日 → 往后顺延到最近的非上班日（周末或假期）
  while (
    isWorkingDay(d, { isHoliday: input.isHoliday, isMakeupWorkday: input.isMakeupWorkday }) &&
    guard++ < guardMax
  ) {
    d = addDays(d, 1);
  }

  // ③ 周末两天都要训练 → 优先换到另一天（那天既不是上班日、也不是训练日）；换不了就饭照吃、训练顺延
  if (isWeekend(d) && input.isTrainingDay(d)) {
    const other = addDays(d, isWeekend(d) && new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 1 : -1);
    const otherOk =
      !isWorkingDay(other, { isHoliday: input.isHoliday, isMakeupWorkday: input.isMakeupWorkday }) &&
      !input.isTrainingDay(other);
    if (otherOk) d = other;
  }

  return d;
}

/** 距上次真的吃了多少天（首页 FR-5 的展示用）。 */
export function cheatDaysSince(anchorDate: DateStr, today: DateStr): number {
  return Math.max(0, dayDiff(anchorDate, today));
}

/** 建议时段文案（只陈述事实，禁止命令式，第 12 章第 2 条）。 */
export function cheatWhenText(): string {
  return "中午";
}
