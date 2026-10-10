/**
 * 加班判定（需求书 3.3 / 13.11 / FR-22 / FR-44）。
 *
 * - 判据固定 **22:30**（训练 21:00 结束 + 回家洗澡），与"提醒时间"这个可配置项无关；
 * - 一天多条记录：取**开始最早**的那条（对他最不利的那条）；
 * - 跨零点的加班（23:00 开始、次日 02:00 结束）：**按开始时间判定**，不看结束时间；
 * - 加班与训练提醒的关系只有两种：豁免（≥22:30）或建议顺延（<22:30），不存在第三种"催你去练"。
 */

import { OVERTIME_JUDGE_TIME } from "@/lib/reminder/decide";
import { addDays, formatCn, hhmmToMinutes, type DateStr, type TimeStr } from "@/lib/time";

export interface OvertimeRecord {
  id: number | string;
  date: string;
  start: TimeStr;
  note?: string | null;
}

export type OvertimeVerdict = "ok" | "late";

export function overtimeVerdict(start: TimeStr): OvertimeVerdict {
  return hhmmToMinutes(start) >= hhmmToMinutes(OVERTIME_JUDGE_TIME) ? "ok" : "late";
}

export function overtimeVerdictText(start: TimeStr): string {
  return overtimeVerdict(start) === "ok" ? "来得及" : "赶不上";
}

/** 当天开始最早的一条（13.11）；没有记录返回 null。 */
export function earliestOvertime<T extends { start: TimeStr }>(records: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of records) {
    if (!best || hhmmToMinutes(r.start) < hhmmToMinutes(best.start)) best = r;
  }
  return best;
}

/**
 * 判定预告文案（保存前就知道这条记录会不会让当晚被催，交互设计说明 §12.4）。
 * `when` 是展示用的时间说法（「今晚」/「明天 · 10月1日 周四」），由调用方给 ——
 * 这条预告要让他在**保存前**看懂，说人话比印日期重要（录「明天」时验收要求点明"那天"）。
 * `opts.restDay`：那天是休息日 / 假期（13.11 / v1.20）→ 只作记录，**不拿"耽误训练"说事**
 * （那两天本来就不发训练提醒，摆个"赶不上"只会让人以为排期要动）。
 */
export function overtimePreviewText(when: string, start: TimeStr, opts?: { restDay?: boolean }): string {
  if (opts?.restDay) {
    return `${when} ${start} 开始 → 那天不练：加班只作记录，不判定是否耽误训练（判据固定 ${OVERTIME_JUDGE_TIME}，只在训练日生效）。`;
  }
  if (overtimeVerdict(start) === "ok") {
    return `${when} ${start} 开始 → 来得及：当晚的训练提醒自动豁免（判据固定 ${OVERTIME_JUDGE_TIME}）。`;
  }
  return `${when} ${start} 开始 → 赶不上：那天的训练提醒只发「赶不上，建议顺延」+ 一键顺延，不会发「你怎么没练」。判据固定 ${OVERTIME_JUDGE_TIME}，不跟着「提醒时间」拨。`;
}

/** 加班记录的日期说法（FR-22 验收：录「明天」要显示成「明天 · M月D日 周X」）。 */
export function overtimeDateLabel(date: DateStr, today: DateStr): string {
  const cn = formatCn(date);
  if (date === today) return `今天 · ${cn}`;
  if (date === addDays(today, 1)) return `明天 · ${cn}`;
  if (date === addDays(today, -1)) return `昨天 · ${cn}`;
  return cn;
}

/** 常用时间点胶囊（FR-22：一点即录，不打字） */
export const OVERTIME_QUICK_TIMES: TimeStr[] = ["20:00", "21:00", "22:00", "23:00"];
