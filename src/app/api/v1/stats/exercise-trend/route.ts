/**
 * GET /api/v1/stats/exercise-trend —— 单个「动作 × 变体」的重量趋势（FR-27 / 13.14）。
 *
 * 每个训练日一个点：当日该动作×变体的最大单侧重量（13.1 的读数口径）、组数与容量。
 * `variant_id` 缺省 = 默认变体（动作本身）；`days` 缺省 90，最大 365。
 */

import { getDb } from "@/db/client";
import { exerciseTrend } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json } from "@/server/http";
import { asNumber } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const exerciseId = asNumber(url.searchParams.get("exercise_id"));
  if (exerciseId === undefined) return badRequest("exercise_id 必填", undefined, request);
  const rawVariant = asNumber(url.searchParams.get("variant_id"));
  const variantId = rawVariant === undefined ? null : rawVariant;
  const days = Math.min(365, Math.max(7, Number(url.searchParams.get("days")) || 90));

  const rows = exerciseTrend(getDb(), exerciseId, variantId, days);
  return json({ exerciseId, variantId, days, rows });
}
