/**
 * 加班记录（3.3 / FR-22 / 13.11）：
 * - GET    /api/v1/overtime          —— 全量列表（我的页维护卡，倒序）
 * - POST   /api/v1/overtime          —— 录入（今日页时间胶囊一点即录）
 * - PATCH  /api/v1/overtime          —— 改日期 / 开始时间 / 备注（id 在请求体里；
 *                                       **必须能改，不能只有删**，踩坑第 36 条）
 * - DELETE /api/v1/overtime?id=      —— 删（前端给 5 秒撤销）
 *
 * 改完当晚判定立刻重算 —— 判定读的就是这张表，没有缓存。
 */

import { getDb } from "@/db/client";
import { addOvertime, getOvertime, deleteOvertime, updateOvertime } from "@/db/writes";
import { dayKindOf, loadScheduleState, overtimesAll } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { parseOvertimeBody } from "@/server/rules";
import { badRequest, json, notFound, readJsonBody, writeJson } from "@/server/http";
import { addDays, dateInTz } from "@/lib/time";
import { overtimeVerdict, overtimeVerdictText } from "@/lib/overtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));

  // 每条带 `dayType`（13.11 / v1.20）：那天是训练日 / 休息日 / 假期 ——
  // 「我的 → 加班记录」的改 / 补录面板按它决定要不要拿"耽误训练"说事
  const db = getDb();
  const today = dateInTz();
  const state = loadScheduleState(db, today);
  return json({
    overtimes: overtimesAll(db, limit).map((o) => ({ ...o, dayType: dayKindOf(o.date, state) })),
    today,
    dayTypes: {
      [today]: dayKindOf(today, state),
      [addDays(today, 1)]: dayKindOf(addDays(today, 1), state),
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // date / start 的格式校验收敛在 server/rules.ts（POST 两栏都必填）
  const overtime = parseOvertimeBody(parsed.body, { requireAll: true, defaultDate: dateInTz() });
  if (!overtime.ok) return badRequest(overtime.issues.join("；"), undefined, request);

  const date = overtime.value.date as string;
  const start = overtime.value.start as string;
  const result = addOvertime(getDb(), { date, start, note: overtime.value.note ?? null });
  return writeJson(request, 
    {
      id: result.id,
      date,
      start,
      verdict: overtimeVerdict(start),
      verdictText: overtimeVerdictText(start),
    },
    { status: 201 },
  );
}

export async function PATCH(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const id = Number(parsed.body.id);
  if (!Number.isInteger(id)) return badRequest("缺少 id", undefined, request);

  const db = getDb();
  if (!getOvertime(db, id)) return notFound("加班记录不存在");

  // PATCH 只校验带来的字段（date / start 的格式校验同样收敛在 server/rules.ts）
  const overtime = parseOvertimeBody(parsed.body, { requireAll: false, defaultDate: dateInTz() });
  if (!overtime.ok) return badRequest(overtime.issues.join("；"), undefined, request);

  updateOvertime(db, id, {
    date: overtime.value.date,
    start: overtime.value.start,
    note: overtime.value.note,
  });
  const updated = getOvertime(db, id);
  return writeJson(request, {
    id,
    date: updated?.date,
    start: updated?.startTime,
    note: updated?.note ?? null,
    verdict: updated ? overtimeVerdict(updated.startTime) : null,
  });
}

export async function DELETE(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return badRequest("缺少 id", undefined, request);
  const result = deleteOvertime(getDb(), id);
  return writeJson(request, { id, removed: result.removed });
}
