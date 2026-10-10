/**
 * GET  /api/v1/holidays?year=2027 —— 读某年假期表（助手写入前先读回核对，踩坑第 28 条）
 * PUT  /api/v1/holidays —— **助手写入假期表**（FR-24 / 13.12）：整年原子覆盖、幂等、
 *        校验失败整单拒绝（库里保持写入前状态），写入记 updated_at / source。
 */

import { getDb } from "@/db/client";
import { holidaysInYear, holidayWriteMeta, HolidayValidationError, replaceHolidayYear } from "@/db/holidays";
import { loadScheduleState } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json, readJsonBody, serverError, writeJson } from "@/server/http";
import { dateInTz } from "@/lib/time";
import { holidayCoverageText } from "@/lib/reminder/holiday-gap";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  const url = new URL(request.url);
  const yearParam = url.searchParams.get("year");
  const today = dateInTz();
  const state = loadScheduleState(db, today);

  if (yearParam) {
    const year = Number(yearParam);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return badRequest("year 必须是 2000~2100 之间的整数", undefined, request);
    }
    return json({
      year,
      days: holidaysInYear(db, year).map((h) => ({ date: h.date, name: h.name, type: h.type })),
      coverage: { end: state.holidayCoverageEnd, text: holidayCoverageText(state.holidayCoverageEnd) },
      meta: holidayWriteMeta(db),
    });
  }

  const years = Array.from(new Set(state.holidays.map((h) => Number(h.date.slice(0, 4))))).sort();
  return json({
    years,
    days: state.holidays,
    coverage: { end: state.holidayCoverageEnd, text: holidayCoverageText(state.holidayCoverageEnd) },
    meta: holidayWriteMeta(db),
  });
}

export async function PUT(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  try {
    const result = replaceHolidayYear(getDb(), parsed.body, {
      source: typeof parsed.body.source === "string" ? parsed.body.source : "assistant",
    });
    return writeJson(request, { ok: true, ...result });
  } catch (error) {
    if (error instanceof HolidayValidationError) {
      // 整单拒绝：返回原因，库里仍是写入前的表
      return badRequest(error.message, error.issues, request);
    }
    return serverError(error instanceof Error ? error.message : "写入失败", request);
  }
}
