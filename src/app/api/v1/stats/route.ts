/**
 * GET /api/v1/stats?days=30 —— 记录页统计卡（近 N 天，原型固定「近 30 天」一档）。
 *
 * - 容量与组数只算训练明细（skipped 的组不计；容量 = Σ total_load_kg × reps，13.1）；
 * - 出勤率口径 13.4：分子 = 训练会话 ∪ workout 打卡的去重天数（打卡算出勤，不等于有明细），
 *   分母 = 窗口内的计划训练日（已扣休息日与法定节假日，补班日照算）。
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { attendanceDates, loadScheduleState, partBreakdown, settingsMap } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { json } from "@/server/http";
import { addDays, dateInTz } from "@/lib/time";
import { attendanceStats } from "@/lib/caliber";
import { asWeightUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30));

  const db = getDb();
  const today = dateInTz();
  const from = addDays(today, -(days - 1));

  const sets = db
    .select({
      skipped: schema.setLog.skipped,
      isWarmup: schema.setLog.isWarmup,
      totalLoadKg: schema.setLog.totalLoadKg,
      reps: schema.setLog.reps,
    })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.setLog.sessionId, schema.workoutSession.id))
    .where(
      and(
        gte(schema.workoutSession.date, from),
        lte(schema.workoutSession.date, today),
        inArray(schema.workoutSession.status, ["doing", "done"]),
      ),
    )
    .all();

  // skipped 与老数据里的热身行都不算训练量（13.1 / 13.16；v1.26 起不再记录热身组）
  const counted = sets.filter((s) => !s.skipped && !s.isWarmup);
  const volumeKg = Math.round(counted.reduce((sum, s) => sum + (s.totalLoadKg ?? 0) * (s.reps ?? 0), 0));

  const state = loadScheduleState(db, today);
  const attendance = attendanceStats(today, days, state.ctx, state.slots, attendanceDates(db));

  return json({
    days,
    from,
    to: today,
    totalSets: counted.length,
    volumeKg,
    // 展示单位（§1.1）：容量与占比按它换算展示，库里始终 kg
    unit: asWeightUnit(settingsMap(db).unit),
    // FR-26：各部位占比（组数与容量两档都给，13.15 大部位口径）
    parts: partBreakdown(db, from, today),
    ...attendance,
  });
}
