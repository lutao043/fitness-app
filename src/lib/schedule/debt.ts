/**
 * 顺延欠账（需求书 13.8）。
 *
 * 语义：
 * - 顺延一天 = 欠 1 个部位（写 skip_day，该日不占循环位，次日补上错过的部位）；
 * - 欠账最多**静默**累积 2 个：要写第 3 条 skip_day 之前先弹重锚询问（先问再改，FR-38）；
 * - 补账顺序 = 欠账先后顺序（先欠的先练）。
 *
 * 「先欠的先练」怎么来：顺延日不占循环位，所以排期自己不会往前走（连续顺延时每天都排到同一个部位）。
 * 欠账队列替它记住先后：第一个欠账日 = 那天排到的部位，之后按循环顺序往后数。
 * 例：连续 2 天顺延，第一天排到「胸+三头」→ 欠「胸+三头、肩+腿」，首页摊开成「欠 2 个部位」。
 * 真实排期在恢复训练后自然沿着这个顺序走（练完胸+三头，下一个训练日就是肩+腿）。
 */

import { addDays, type DateStr } from "@/lib/time";
import { slotIndexAt } from "./cycle";
import type { ScheduleCtx, SlotLike } from "./types";

export interface OwedPart {
  /** 被顺延的那一天 */
  date: DateStr;
  /** 那天欠下的部位（按欠账队列顺序） */
  part: string;
}

/**
 * 欠账清单：最后一次训练/打卡之后、到今天为止的所有顺延日（按时间升序）。
 * `lastRecordDate` 为 null（从没练过）时，全部顺延日都算欠账。
 */
export function owedParts(
  today: DateStr,
  ctx: ScheduleCtx,
  slots: readonly SlotLike[],
  lastRecordDate: DateStr | null,
  maxDays = 60,
): OwedPart[] {
  if (slots.length === 0) return [];
  const skipDays: DateStr[] = [];
  let d = today;
  for (let i = 0; i < maxDays; i++) {
    if (ctx.skips.has(d) && (lastRecordDate === null || d > lastRecordDate)) skipDays.push(d);
    if (lastRecordDate !== null && d <= lastRecordDate) break;
    d = addDays(d, -1);
  }
  skipDays.reverse(); // 欠账先后顺序
  if (skipDays.length === 0) return [];

  const baseIndex = slotIndexAt(skipDays[0], ctx);
  return skipDays.map((date, i) => ({
    date,
    part: slots[(baseIndex + i) % slots.length].label,
  }));
}

/** 欠账上限（13.8）：静默最多 2 个，第 3 个要先问重锚。 */
export const SILENT_DEBT_LIMIT = 2;

/** 今天再点一次「今天不练」是否要先弹重锚询问。 */
export function needsReanchorBeforeSkip(owed: readonly OwedPart[]): boolean {
  return owed.length + 1 > SILENT_DEBT_LIMIT;
}

/** 首页欠账条文案：「欠 2 个部位：胸+三头、肩+腿」；不欠账时返回 null。 */
export function owedText(owed: readonly OwedPart[]): string | null {
  if (owed.length === 0) return null;
  return `欠 ${owed.length} 个部位：${owed.map((o) => o.part).join("、")}`;
}
