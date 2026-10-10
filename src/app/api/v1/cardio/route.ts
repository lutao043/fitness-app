/**
 * 有氧（爬坡走，FR-50 / FR-51，v1.16）：
 * - GET    /api/v1/cardio?days=14  —— 有氧记录（升序），今日页与记录页共用
 * - POST   /api/v1/cardio          —— 记 / 改某天：`{date?, minutes, note?}`；**同一天重复提交 = 覆盖**（幂等）
 * - DELETE /api/v1/cardio?date=    —— 撤销某天的记录
 *
 * 口径（13.4 / 13.6）：有氧是独立的第三类事实 —— **不算出勤、不进容量、不参与 streak**，
 * 只记分钟数（形式固定「爬坡走」，坡度/速度不记，3.6 不做精算）。
 */

import { getDb } from "@/db/client";
import { cardioList } from "@/db/queries";
import { deleteCardioLog, upsertCardioLog } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { parseCardioBody } from "@/server/rules";
import { badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { addDays, dateInTz, isValidDateStr } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get("days") ?? 14);
  const days = Number.isFinite(daysParam) ? Math.min(365, Math.max(1, Math.round(daysParam))) : 14;
  const today = dateInTz();
  const rows = cardioList(getDb(), { from: addDays(today, -(days - 1)), to: today });
  const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);
  return json({ rows, days, totalMinutes, totalDays: rows.length });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // minutes 范围（1~600）与 date 窗口（今天 / 昨天）都收敛在 server/rules.ts（13.19 的范围表）
  const today = dateInTz();
  const cardio = parseCardioBody(parsed.body, { today, yesterday: addDays(today, -1) });
  if (!cardio.ok) return badRequest(cardio.issues.join("；"), undefined, request);

  const { date, minutes, note } = cardio.value;
  const result = upsertCardioLog(getDb(), { date, minutes, note });
  return writeJson(request, { id: result.id, date, minutes, created: result.created }, { status: result.created ? 201 : 200 });
}

export async function DELETE(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date || !isValidDateStr(date)) return badRequest("缺少 date（YYYY-MM-DD）", undefined, request);
  const result = deleteCardioLog(getDb(), date);
  return writeJson(request, { date, removed: result.removed });
}
