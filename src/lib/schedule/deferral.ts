/**
 * 归因：「这一天为什么不是"锚点直推的正常一天"」（需求书 13.7 / 13.8 / 13.17）。
 *
 * `GET /today` 与 `GET /api/v1/schedule/upcoming` 共用这一份（助手侧对拍要求两处同源，
 * 不许各写一套判断）。
 *
 * - `holiday`：法定节假日 —— 不占循环位，循环在这天"停一拍"（13.7）
 * - `skip`：顺延日（`skip_day`）—— 不占循环位，那天该练的部位顺延到下一个训练日（13.8）
 * - `extra_shift`：该日的循环位由**加练位点**决定 —— 位点只影响该日及以后（13.17），
 *   所以从加练那天起（直到下一条位点）都算"被挪过"
 * - `null`：正常（补班日也算正常 —— 它占循环位，13.7 的坑）
 *
 * 优先级 `holiday` > `skip` > `extra_shift`：同一天只报最靠前的那条（这天本身不占位的原因
 * 比"位次被挪过"更直接）。
 */

import type { CyclePoint, ScheduleCtx } from "./types";
import type { DateStr } from "@/lib/time";

export type Deferral = "holiday" | "skip" | "extra_shift";

export function deferralOf(date: DateStr, ctx: ScheduleCtx): Deferral | null {
  if (ctx.holidays.has(date)) return "holiday";
  if (ctx.skips.has(date)) return "skip";

  // 最后一个不晚于该日的位点；位点若早于锚点日期则不生效（baseAt 也按这个顺序取）
  const points: readonly CyclePoint[] = ctx.points ?? [];
  let latest: CyclePoint | null = null;
  for (const p of points) {
    if (p.date > date) continue;
    if (!latest || p.date >= latest.date) latest = p;
  }
  return latest && latest.date >= ctx.anchor.date ? "extra_shift" : null;
}
