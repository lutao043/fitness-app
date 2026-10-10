/**
 * GET /api/v1/stats/exercises —— 有记录的「动作 × 变体」清单（FR-27 选择器用）。
 * 趋势一律按「动作 × 变体」一条线（FR-49 / 13.14），按最近练的在前。
 */

import { getDb } from "@/db/client";
import { recordedExerciseVariants } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
  return json({ rows: recordedExerciseVariants(getDb(), limit) });
}
