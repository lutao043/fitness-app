/**
 * POST /api/v1/checkin —— 一键打卡（FR-30）：`{date, kind:"workout"|"supplement", ref_id?}`。
 *
 * - 打卡是**出勤事实**，不编明细（13.4）；助手也能代他打卡（source=assistant）；
 * - 按 `(date, kind, ref_id)` 去重：重复打卡 = no-op，返回既有记录。
 */

import { getDb } from "@/db/client";
import { ensureCheckin } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asString, badRequest, oneOf, readJsonBody, writeJson } from "@/server/http";
import { dateInTz, isValidDateStr } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const date = asString(body.date) ?? dateInTz();
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);
  const kind = oneOf(body.kind, ["workout", "supplement"] as const);
  if (!kind) return badRequest('kind 只能是 "workout" 或 "supplement"', undefined, request);

  const refId = asString(body.ref_id ?? body.refId) ?? null;
  if (kind === "supplement" && !refId) return badRequest("补剂打卡必须带 ref_id（补剂 id）", undefined, request);

  const source =
    auth.via === "token"
      ? ("assistant" as const)
      : (oneOf(body.source, ["web", "assistant", "reminder"] as const) ?? "web");

  const result = ensureCheckin(getDb(), { date, kind, refId, source });
  return writeJson(request, { ...result, date, kind, source }, { status: result.created ? 201 : 200 });
}
