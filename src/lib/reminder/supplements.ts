/**
 * 补剂提醒（需求书 13.10 第 2 条 + FR-33）。
 *
 * 第 2 条是**并列分支**：每种补剂"没打卡才提，打卡了就不提"，与训练提醒的其余判定互不影响
 * （法定节假日不发训练提醒，但补剂提醒照发）。
 *
 * 打卡的唯一事实源是 `checkin(kind=supplement, ref_id)`（需求书第 6 章 / v1.13：不设第二张补剂打卡表）。
 */

import { hhmmToMinutes, type DateStr, type TimeStr } from "@/lib/time";

export interface SupplementDueInput {
  supplementId: string | number;
  name: string;
  /** 提醒时点列表（HH:mm，可多个，全部可在设置页改 —— FR-40 / FR-33） */
  times: readonly TimeStr[];
  /** 今天是否已经打卡 */
  takenToday: boolean;
  /** 今天这条补剂的事件是否已经生成过（去重键 type=supplement + ref_key=supp:<id> + date） */
  eventAlreadyGenerated: boolean;
  /** 判定时刻 */
  at: TimeStr;
  /**
   * 补剂的「适用日」在今天成不成立（v1.49 / 13.21）：`daily` 恒为 true（= 分档前行为）。
   * 不成立 → 该条今天不提（打卡入口照给，适用日只作用于提醒）。
   */
  appliesToday?: boolean;
}

export interface SupplementDueResult {
  due: boolean;
  /** 到点判定用的那个时点（取 ≤ at 的最早一个） */
  dueTime: TimeStr | null;
  reason: "taken" | "not_yet" | "already_sent" | "due" | "off_day";
}

const toMinutes = (t: TimeStr) => hhmmToMinutes(t);

export function decideSupplement(input: SupplementDueInput): SupplementDueResult {
  // 适用日不成立 = 今天这条根本不在"该提的日子"里（先于到点 / 打卡判，13.21）
  if (input.appliesToday === false) return { due: false, dueTime: null, reason: "off_day" };
  if (input.takenToday) return { due: false, dueTime: null, reason: "taken" };
  const passed = input.times.filter((t) => toMinutes(t) <= toMinutes(input.at)).sort();
  if (passed.length === 0) return { due: false, dueTime: null, reason: "not_yet" };
  if (input.eventAlreadyGenerated) {
    return { due: false, dueTime: passed[0], reason: "already_sent" };
  }
  return { due: true, dueTime: passed[0], reason: "due" };
}

/** 补剂事件的引用键（13.10 去重键 = type + ref_key + date） */
export function supplementRefKey(supplementId: string | number): string {
  return `supp:${supplementId}`;
}

/** 补剂打卡按自然日归属（13.3）：00:20 打卡记的是新的一天 */
export function supplementCheckinKey(date: DateStr, supplementId: string | number): string {
  return `${date}#${supplementId}`;
}
