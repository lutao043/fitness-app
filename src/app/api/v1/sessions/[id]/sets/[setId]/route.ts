/**
 * PATCH  /api/v1/sessions/{id}/sets/{setId} —— 补 / 改这一组（FR-13：补重量）
 * DELETE /api/v1/sessions/{id}/sets/{setId} —— 删记错的组（FR-13）
 *
 * 改重量会重算 `total_load_kg`（容量口径 13.1 / 13.14），并返回重算后的小结。
 * 热身组已取消（v1.26）：`is_warmup: true` 一律 400，历史行的标记也不可改。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { deleteSetLog, updateSetLog } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asBool, asNumber, badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { refreshSessionSummary, setReadingIssue } from "@/server/session";
import { SET_FEELS } from "@/server/rules";
import { totalLoadKg } from "@/lib/caliber";
import type { LoadSemantics } from "@/lib/exercise/types";

export const dynamic = "force-dynamic";

async function loadSet(sessionId: number, setLogId: number) {
  const db = getDb();
  const row = db
    .select()
    .from(schema.setLog)
    .where(and(eq(schema.setLog.id, setLogId), eq(schema.setLog.sessionId, sessionId)))
    .get();
  if (!row) return { db, row: null as null };
  return { db, row };
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; setId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id, setId } = await ctx.params;
  const sessionId = Number(id);
  const setLogId = Number(setId);
  if (!Number.isInteger(sessionId) || !Number.isInteger(setLogId)) return badRequest("参数不合法", undefined, request);

  const { db, row } = await loadSet(sessionId, setLogId);
  if (!row) return notFound("这一组不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const exercise = db.select().from(schema.exercise).where(eq(schema.exercise.id, row.exerciseId)).get();
  if (!exercise) return notFound("动作不存在");
  const variant = row.variantId
    ? db.select().from(schema.exerciseVariant).where(eq(schema.exerciseVariant.id, row.variantId)).get()
    : null;
  const semantics: LoadSemantics = variant?.loadSemantics ?? "direct";

  // 读数：只有"带来了"才校验 / 更新；**带来了但非数字照样 400**（别静默当没传）
  const rawWeight = body.weight_kg ?? body.weightKg;
  const rawReps = body.reps;
  for (const [label, raw] of [
    ["weight_kg", rawWeight],
    ["reps", rawReps],
  ] as const) {
    if (raw !== undefined && raw !== null && asNumber(raw) === undefined) {
      return badRequest(`${label} 必须是数字（或留空）`, undefined, request);
    }
  }
  const weightKg = rawWeight === undefined || rawWeight === null ? undefined : asNumber(rawWeight);
  const reps = rawReps === undefined || rawReps === null ? undefined : asNumber(rawReps);
  const durationSec = asNumber(body.duration_sec ?? body.durationSec);
  // 感受：可以不标 / 显式清空；**给了非枚举值一律 400**（issue #14 第 4 条：枚举不静默兜底）
  const rawFeel = body.feel;
  let feel: (typeof SET_FEELS)[number] | undefined;
  if (rawFeel !== undefined && rawFeel !== null && rawFeel !== "") {
    feel = SET_FEELS.find((f) => f === rawFeel);
    if (!feel) return badRequest(`feel 只能是 ${SET_FEELS.join(" / ")}`, undefined, request);
  }

  // 热身组已取消（v1.26，FR-53 改写为练前提示）：不能事后把一组标成热身，也不改历史行的标记 ——
  // 传 true 一律 400（不做静默忽略）；false / 缺省照旧
  if (asBool(body.is_warmup ?? body.isWarmup) === true) {
    return badRequest("热身组不再记录（v1.26 起改为练前提示）：不能标热身", undefined, request);
  }

  // 补 / 改读数与记一组同一套范围校验（issue #1 第 5 项），只校验本次提交的字段
  const readingIssue = setReadingIssue(weightKg, reps);
  if (readingIssue) return badRequest(readingIssue, undefined, request);

  const nextWeight = weightKg === undefined ? row.weightKg : weightKg;
  const total = totalLoadKg({
    weightKg: nextWeight,
    loadMode: exercise.loadMode,
    barKg: exercise.barKg,
    semantics,
  });

  updateSetLog(db, setLogId, {
    weightKg: weightKg === undefined ? undefined : weightKg,
    reps: reps === undefined ? undefined : reps,
    durationSec: durationSec === undefined ? undefined : durationSec,
    feel: feel === undefined ? undefined : feel,
    totalLoadKg: total,
  });

  // 改一组也要把小结重算落库（FR-13 v1.18）：不然记录页与今日页还挂着旧容量
  return writeJson(request, { id: setLogId, totalLoadKg: total, summary: refreshSessionSummary(db, sessionId) });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; setId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id, setId } = await ctx.params;
  const sessionId = Number(id);
  const setLogId = Number(setId);
  if (!Number.isInteger(sessionId) || !Number.isInteger(setLogId)) return badRequest("参数不合法", undefined, request);

  const { db, row } = await loadSet(sessionId, setLogId);
  if (!row) return notFound("这一组不存在");

  deleteSetLog(db, setLogId);
  return writeJson(
    request,
    { id: setLogId, removed: true, summary: refreshSessionSummary(db, sessionId) },
    undefined,
    // 删除类记 **before 值**（issue #40 验收 3）：删错了才还原得出删的是什么
    {
      change: {
        id: setLogId,
        removed: true,
        setNo: row.setNo,
        weightKg: row.weightKg,
        reps: row.reps,
        doneAt: row.doneAt,
      },
    },
  );
}
