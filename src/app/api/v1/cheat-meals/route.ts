/**
 * POST /api/v1/cheat-meals —— 记「今天真吃了」→ 自动把锚点挪到今天（FR-25 / 3.4）。
 * 同时可改间隔天数（间隔与锚点都在这里维护）。
 */

import { getDb } from "@/db/client";
import { recordCheatMeal, setSetting } from "@/db/writes";
import { loadScheduleState } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { asNumber, asString, badRequest, readJsonBody, writeJson } from "@/server/http";
import { isTrainingDay } from "@/lib/schedule";
import { cheatNext } from "@/lib/caliber/cheat";
import { dateInTz, isValidDateStr } from "@/lib/time";
import * as schema from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const date = asString(body.date) ?? dateInTz();
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);

  const db = getDb();
  const intervalDays = asNumber(body.interval_days ?? body.intervalDays);
  if (intervalDays !== undefined) {
    if (intervalDays < 1 || intervalDays > 60) return badRequest("interval_days 必须在 1~60 之间", undefined, request);
    const setting = db.select().from(schema.cheatSetting).orderBy(desc(schema.cheatSetting.id)).get();
    if (setting) {
      db.update(schema.cheatSetting)
        .set({ intervalDays: Math.round(intervalDays) })
        .where(eq(schema.cheatSetting.id, setting.id))
        .run();
    }
  }

  const logged = recordCheatMeal(db, { date, note: asString(body.note) ?? null });

  const state = loadScheduleState(db, date);
  const setting = db.select().from(schema.cheatSetting).orderBy(desc(schema.cheatSetting.id)).get();
  // 「下次建议」是给现在用的，按**今天**算 —— 与今日接口 / 页面同一个口径。
  // 不按 `date` 算：补记一条过去那天的记录（如 issue #4 第 2 项补 09-19）时，
  // 传 date 会返回一个早就过去的建议日，跟页面上看到的对不上。
  const today = dateInTz();
  const nextDate = setting
    ? cheatNext({
        anchorDate: setting.anchorDate,
        intervalDays: setting.intervalDays,
        today,
        isHoliday: (d) => state.holidaySet.has(d),
        isMakeupWorkday: (d) => state.makeupSet.has(d),
        isTrainingDay: (d) => isTrainingDay(d, state.ctx, state.slots),
      })
    : today;

  // 清掉缓存里可能残留的旧设置（当前实现下不存在缓存，这里只是保证语义显式）
  setSetting(db, "cheat_updated_at", new Date().toISOString());

  return writeJson(request, { id: logged.id, date, anchorDate: date, nextDate }, { status: 201 });
}
