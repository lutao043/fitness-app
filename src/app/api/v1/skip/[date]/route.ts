/**
 * DELETE /api/v1/skip/{date} —— 撤销顺延（13.8 的 5 秒撤销走它）：删掉该日 skip_day，排期回原样。
 */

import { getDb } from "@/db/client";
import { removeSkip } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, writeJson } from "@/server/http";
import { isValidDateStr } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, ctx: { params: Promise<{ date: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { date } = await ctx.params;
  if (!isValidDateStr(date)) return badRequest("日期不合法（YYYY-MM-DD）", undefined, request);

  const result = removeSkip(getDb(), date);
  return writeJson(request, { date, removed: result.removed });
}
