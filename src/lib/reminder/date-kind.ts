/**
 * 日期态（需求书 13.21，v1.49 / issue #70）—— 唯一一份判定。
 *
 * 触发场景：2026-10-10（周六·国庆补班）助手侧按"周末档"发提醒 —— 整套提醒里
 * 只有"周六周日 = 周末"，没有「调休上班」这一态。`workday` 类型的补班日假期表里一直有
 * （13.12），此前没参与任何判定，缺的是判定维度。
 *
 * 四种态（与助手侧 `scripts/datekind.py` 逐条一致，两侧对同一张假期表必须得出同一个态）：
 *   workday  工作日       周一~周五，且假期表里没有它的记录        → 工作日档
 *   makeup   调休上班日   周六 / 周日，但假期表 type=workday（补班）→ 工作日档
 *   weekend  周末         周六 / 周日，且没有补班记录              → 休息日档
 *   holiday  法定节假日   假期表 type=holiday（落在周末也是 holiday）→ 休息日档
 *
 * 训练提醒时间分两档（13.10 的 8 条顺序一个字不动，这里只决定"什么时刻触发"）；
 * 加班判据仍固定 22:30（13.11），不随档位拨。
 */

import { isWeekend, type DateStr, type TimeStr } from "@/lib/time";

/** 假期表里的类型（与 `db/holidays.ts` 的 HolidayType 同义；lib 不 import db，所以在这里独立声明） */
export type HolidayType = "holiday" | "workday";

export type DateKind = "workday" | "makeup" | "weekend" | "holiday";

/** 补剂「适用日」（supplement.day_kind）：daily = 每天（默认，= 分档前行为） */
export type SupplementDayKind = "daily" | "workday" | "restday";

export const SUPPLEMENT_DAY_KINDS: readonly SupplementDayKind[] = ["daily", "workday", "restday"] as const;

/** 今天的日期态。假期表有记录时以它为准（补班日优先于"周末"，节假日优先于一切在周几）。 */
export function dateKind(date: DateStr, holidayType: HolidayType | null): DateKind {
  if (holidayType === "holiday") return "holiday";
  if (holidayType === "workday") return "makeup";
  return isWeekend(date) ? "weekend" : "workday";
}

/** 演练 / 页面上显示的名字 */
export function dateKindLabel(kind: DateKind): string {
  switch (kind) {
    case "workday":
      return "工作日";
    case "makeup":
      return "调休上班日";
    case "weekend":
      return "周末";
    default:
      return "法定节假日";
  }
}

/** 这个态用哪个时间档：工作日与调休上班日走工作日档，周末与法定节假日走休息日档。 */
export function reminderTimeForKind(kind: DateKind, times: { workday: TimeStr; restday: TimeStr }): TimeStr {
  return kind === "workday" || kind === "makeup" ? times.workday : times.restday;
}

/** 这个态是不是"工作日类"（工作日 + 调休上班日）—— 补剂「仅工作日 / 仅休息日」按它判。 */
export function isWorkdayKind(kind: DateKind): boolean {
  return kind === "workday" || kind === "makeup";
}

/** 补剂的适用日在今天成不成立（13.10 第 2 条并列分支里的一条日期态判据） */
export function dayKindApplies(dayKind: SupplementDayKind, kind: DateKind): boolean {
  if (dayKind === "daily") return true;
  return dayKind === "workday" ? isWorkdayKind(kind) : !isWorkdayKind(kind);
}

/** 补剂「适用日」在清单 / 页面上显示的名字 */
export function supplementDayKindLabel(dayKind: SupplementDayKind): string {
  switch (dayKind) {
    case "workday":
      return "仅工作日";
    case "restday":
      return "仅休息日";
    default:
      return "每天";
  }
}
