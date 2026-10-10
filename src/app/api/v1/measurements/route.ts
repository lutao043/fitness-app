/**
 * 围度记录（FR-15 / 第 6 章 measurement 表）：腰围 / 胸围 / 臂围 / 腿围。
 *
 * - POST `{date?, waist_cm?, chest_cm?, arm_cm?, thigh_cm?}`，**同日一条、重复保存 = 覆盖**（date 唯一）；
 *   至少一项有值才收（没有"全空的测量"）；
 * - 不强制天天记，每周一次足够（FR-15），UI 文案同样如此 —— 这是参考节奏，不是校验；
 * - GET 返回升序序列（曲线用，FR-17）。
 */

import { getDb } from "@/db/client";
import { upsertMeasurement } from "@/db/writes";
import { measurementsList } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { asNumber, asString, badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { dateInTz, isValidDateStr } from "@/lib/time";

export const dynamic = "force-dynamic";

/** 围度的合理量程（cm）；防手滑，不做"体型判断" */
const CM_MIN = 20;
const CM_MAX = 200;

function readCm(value: unknown, label: string): number | null | string {
  const raw = asNumber(value);
  if (raw === undefined) return null;
  if (raw < CM_MIN || raw > CM_MAX) return `${label} 必须是 ${CM_MIN}~${CM_MAX} 之间的数字`;
  return raw;
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const date = asString(body.date) ?? dateInTz();
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);

  const waist = readCm(body.waist_cm ?? body.waistCm, "waist_cm");
  if (typeof waist === "string") return badRequest(waist, undefined, request);
  const chest = readCm(body.chest_cm ?? body.chestCm, "chest_cm");
  if (typeof chest === "string") return badRequest(chest, undefined, request);
  const arm = readCm(body.arm_cm ?? body.armCm, "arm_cm");
  if (typeof arm === "string") return badRequest(arm, undefined, request);
  const thigh = readCm(body.thigh_cm ?? body.thighCm, "thigh_cm");
  if (typeof thigh === "string") return badRequest(thigh, undefined, request);

  if (waist === null && chest === null && arm === null && thigh === null) {
    return badRequest("至少要有一项围度有值", undefined, request);
  }

  const result = upsertMeasurement(getDb(), {
    date,
    waistCm: waist,
    chestCm: chest,
    armCm: arm,
    thighCm: thigh,
  });
  return writeJson(request, { ...result, date }, { status: result.created ? 201 : 200 });
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const limit = Math.min(365, Math.max(1, Number(url.searchParams.get("limit")) || 180));
  return json({ rows: measurementsList(getDb(), limit) });
}
