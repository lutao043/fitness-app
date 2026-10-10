/**
 * GET /api/v1/schedule/upcoming?days=14&from=YYYY-MM-DD —— 未来 N 天的排期事实（只读，v1.28）。
 *
 * 给助手侧对拍用：助手每天要核「今天该练什么 / 有没有顺延 / 循环位有没有漂」，但只有
 * `GET /today`（一天）时会忍不住自己推演一遍 13.7 的算法 —— 等于把口径抄两份，抄错就误判。
 * 这个接口把同一套纯函数一次给出一段连续日期，**不返回动作清单**（体积大、助手不需要，清单仍走 /today）。
 *
 * 与 /today **必须同源**：`part` / `is_training_day` / `cycle_index` / `holiday` / `deferred`
 * 与 `GET /today?date=` 的 `part` / `isTrainingDay` / `scheme.slotIndex` / `holiday.name` / `deferred`
 * 逐字段一致（接口级用例钉住）。
 *
 * 参数：`days` 1~60（缺省 14）；`from` 只能填今天 —— 早于今天要回看历史请用 `GET /today?date=`，
 * 晚于今天不接受（要往后看请加大 `days`）：这个接口的存在意义是"以今天为锚对拍"，
 * 允许任意起点会让人拿它当通用排期器用，掩盖"助手与 App 的今天不是同一天"这类错位。
 */

import { getDb } from "@/db/client";
import { loadScheduleState } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json } from "@/server/http";
import { addDays, dateInTz, formatCn, isValidDateStr } from "@/lib/time";
import { deferralOf, isTrainingDay, partOf, slotIndexAt } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const MIN_DAYS = 1;
const MAX_DAYS = 60;
const DEFAULT_DAYS = 14;

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const today = dateInTz();

  const fromRaw = url.searchParams.get("from");
  const from = fromRaw === null || fromRaw === "" ? today : fromRaw;
  if (!isValidDateStr(from)) return badRequest("from 不是合法日期（YYYY-MM-DD）", undefined, request);
  if (from < today) {
    return badRequest("from 不能早于今天（要回看历史请用 GET /today?date=）", undefined, request);
  }
  if (from > today) {
    return badRequest("from 只能是今天（要往后看请加大 days；未来日不单独作为起点）", undefined, request);
  }

  const daysRaw = url.searchParams.get("days");
  const days = daysRaw === null || daysRaw === "" ? DEFAULT_DAYS : Number(daysRaw);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return badRequest(`days 必须是 ${MIN_DAYS}~${MAX_DAYS} 的整数`, undefined, request);
  }

  const state = loadScheduleState(getDb(), from);
  const { ctx, slots } = state;

  const items = Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    const holidayRow = state.holidays.find((h) => h.date === date);
    return {
      date,
      weekday: formatCn(date).split(" ").at(-1) ?? "",
      part: partOf(date, ctx, slots),
      is_training_day: isTrainingDay(date, ctx, slots),
      cycle_index: slotIndexAt(date, ctx),
      // 只算法定节假日；补班日（type = "workday"）占循环位、按训练日算，不是假期
      holiday: holidayRow && holidayRow.type === "holiday" ? holidayRow.name : null,
      deferred: deferralOf(date, ctx),
    };
  });

  return json({ from, days, cycle_len: ctx.cycleLen, items });
}
