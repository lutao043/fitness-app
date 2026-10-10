/**
 * POST /api/v1/body-metrics —— 记体重（FR-14 / 13.2）
 *   `{date, slot?, weight_kg, body_fat_pct?}`；slot 缺省 = morning。
 *   同日同时点重复保存 = 覆盖（幂等）；读数越界（weight 0~400 不含 0 / body_fat_pct 0~75）整条 400。
 * GET  /api/v1/body-metrics —— 身体数据序列（曲线与"上次体重"用）。
 * DELETE /api/v1/body-metrics?date=&slot= —— 删掉某天某时点这一条（issue #10 附带一问）：
 *   记错日期 / 称重失败的记录只能删掉，覆盖修不了；没有这条也返回 200 + `removed:false`（幂等，
 *   与 `DELETE /api/v1/skip/{date}` 同惯例）。`slot` 缺省 = morning（与 POST 同）。
 */

import { getDb } from "@/db/client";
import { deleteBodyMetric, upsertBodyMetric } from "@/db/writes";
import { bodySeries, latestBodyMetric, settingsMap } from "@/db/queries";
import { requireApiAuth, userRow } from "@/server/auth";
import { parseBodyMetricBody } from "@/server/rules";
import { badRequest, json, oneOf, readJsonBody, writeJson } from "@/server/http";
import { dateInTz, isValidDateStr } from "@/lib/time";
import { asWeightUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // 字段解析与值域校验收敛在 server/rules.ts（13.19 的范围表与那里的常量逐项对齐）
  const body = parseBodyMetricBody(parsed.body, { defaultDate: dateInTz() });
  if (!body.ok) return badRequest(body.issues.join("；"), undefined, request);

  const result = upsertBodyMetric(getDb(), {
    date: body.value.date,
    slot: body.value.slot,
    weightKg: body.value.weightKg,
    bodyFatPct: body.value.bodyFatPct,
    note: body.value.note,
  });
  return writeJson(request, 
    { ...result, date: body.value.date, slot: body.value.slot },
    { status: result.created ? 201 : 200 },
  );
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  const url = new URL(request.url);
  const limit = Math.min(365, Math.max(1, Number(url.searchParams.get("limit") ?? 180)));
  const { latestMorning, latestAny } = latestBodyMetric(db, dateInTz());
  return json({
    series: bodySeries(db, limit),
    latestMorning,
    latestAny,
    // 与今日页目标卡同源（user 表），不再硬编码
    target: userRow(db)?.targetWeightKg ?? 70,
    // 展示单位（§1.1）：体重按它换算展示、录入按它换算回 kg，库里始终 kg
    unit: asWeightUnit(settingsMap(db).unit),
  });
}

/** 删掉某天某时点这一条（`?date=&slot=`）；没有这条 = `removed:false`（幂等） */
export async function DELETE(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);
  const rawSlot = url.searchParams.get("slot");
  // 非法 slot 一律 400（与 POST 的 reason / slot 词表同一条原则：不静默兜底成别的时点）
  const slot =
    rawSlot === null || rawSlot === ""
      ? "morning"
      : oneOf(rawSlot, ["morning", "bedtime", "other"] as const);
  if (!slot) return badRequest("slot 只能是 morning / bedtime / other", undefined, request);

  const removed = deleteBodyMetric(getDb(), { date, slot });
  return writeJson(request, { date, slot, removed });
}
