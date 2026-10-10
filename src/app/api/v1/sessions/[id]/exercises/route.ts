/**
 * 本次会话的动作清单（FR-10 的 doing 阶段 —— 训练中可增删动作、调顺序、调本次目标组数）：
 *
 *   POST   /api/v1/sessions/{id}/exercises            —— 加一个动作（加在末尾）
 *   PATCH  /api/v1/sessions/{id}/exercises            —— `{id, move?|target_sets?|target_reps?|exercise_id?}`
 *   DELETE /api/v1/sessions/{id}/exercises?id=<seId>  —— 移出今天
 *
 * 三条安全约束（交互设计说明 §4.9）：
 * 1. 目标组数不能低于已记组数（否则进度自相矛盾）→ 400；
 * 2. 移出 / 换掉已经记过组的动作要**二次确认**（`confirm: true`）—— 确认后连同那一动作本次已记的组一起删，
 *    并如实告诉调用方删了几组（先 409 返回待确认，与 /skip 的欠账确认同一个套路）；
 * 3. 至少留一个动作。
 *
 * 只影响本次会话：模板要改走计划页的「把这套存回模板」（FR-21）。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import {
  addSessionExercise,
  countSetsOfExercise,
  exerciseById,
  removeSessionExercise,
  reorderSessionExercise,
  sessionExerciseById,
  updateSessionExercise,
} from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asBool, asNumber, badRequest, notFound, oneOf, readJsonBody, writeJson } from "@/server/http";

export const dynamic = "force-dynamic";

function loadSession(sessionId: number) {
  const db = getDb();
  return db.select().from(schema.workoutSession).where(eq(schema.workoutSession.id, sessionId)).get() ?? null;
}

function listCount(sessionId: number): number {
  const db = getDb();
  return db
    .select({ id: schema.sessionExercise.id })
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, sessionId))
    .all().length;
}

/**
 * 已经放弃的会话不再改清单；**已经收工的允许「补一个动作」**（FR-13 补明细 / v1.18）——
 * 打卡日或漏记的日子事后补明细是合法操作，补完小结会重算。
 * 但改/删（PATCH / DELETE）仍然只允许在做训练中做：删掉已收工会话的动作会连带丢组。
 */
function closedResponse(sessionId: number, status: string, request: Request) {
  return badRequest(`会话状态是 ${status}，清单不能再改（历史记录请在详情页补明细 / 删组）`, undefined, request);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const session = loadSession(sessionId);
  if (!session) return notFound("会话不存在");
  if (session.status === "aborted") {
    return closedResponse(sessionId, session.status, request);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const exerciseId = asNumber(body.exercise_id ?? body.exerciseId);
  if (!exerciseId) return badRequest("缺少 exercise_id", undefined, request);
  if (!exerciseById(getDb(), exerciseId)) return badRequest("动作不存在", undefined, request);

  const targetSets = asNumber(body.target_sets ?? body.targetSets) ?? 3;
  const targetReps = asNumber(body.target_reps ?? body.targetReps) ?? 12;
  if (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > 20) {
    return badRequest("target_sets 必须是 1~20 的整数", undefined, request);
  }
  if (!Number.isInteger(targetReps) || targetReps < 1 || targetReps > 999) {
    return badRequest("target_reps 必须是 1~999 的整数", undefined, request);
  }
  if (listCount(sessionId) >= 30) return badRequest("一次会话最多 30 个动作", undefined, request);

  const created = addSessionExercise(getDb(), { sessionId, exerciseId, targetSets, targetReps });
  return writeJson(request, { id: created.id, exerciseId, orderNo: created.orderNo }, { status: 201 });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const session = loadSession(sessionId);
  if (!session) return notFound("会话不存在");
  if (session.status === "done" || session.status === "aborted") {
    return closedResponse(sessionId, session.status, request);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const db = getDb();

  const seId = asNumber(body.id);
  if (!seId) return badRequest("缺少 id（本次会话里的动作行 id）", undefined, request);
  const row = sessionExerciseById(db, seId);
  if (!row || row.sessionId !== sessionId) return notFound("这次会话里没有这一条动作");

  const confirm = asBool(body.confirm) ?? false;

  // ① 调顺序（含「先做这个」= move: first）
  const move = oneOf(body.move, ["up", "down", "first"] as const);
  if (move) {
    const result = reorderSessionExercise(db, seId, move);
    return writeJson(request, { id: seId, moved: result.moved });
  }

  // ② 换动作：位置不动、目标组数次数保留；已记的组按确认结果处理
  const swapTo = asNumber(body.exercise_id ?? body.exerciseId);
  if (swapTo !== undefined) {
    if (!exerciseById(db, swapTo)) return badRequest("要换成的动作不存在", undefined, request);
    if (swapTo === row.exerciseId) return writeJson(request, { id: seId, exerciseId: swapTo, changed: false });
    const recorded = countSetsOfExercise(db, sessionId, row.exerciseId);
    if (recorded > 0 && !confirm) {
      return writeJson(request, 
        {
          error: `这个动作已经记了 ${recorded} 组，换掉会连那 ${recorded} 组一起删掉（换掉 = 今天不做它了）。`,
          written: false,
          needs_confirm: true,
          sets: recorded,
        },
        { status: 409 },
      );
    }
    updateSessionExercise(db, seId, { exerciseId: swapTo });
    if (recorded > 0 && confirm) {
      db.delete(schema.setLog)
        .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.exerciseId, row.exerciseId)))
        .run();
    }
    return writeJson(request, { id: seId, exerciseId: swapTo, changed: true, deletedSets: confirm ? recorded : 0 });
  }

  // ③ 调本次目标组数次数（组数不能低于已记组数，否则进度自相矛盾）
  const targetSets = asNumber(body.target_sets ?? body.targetSets);
  const targetReps = asNumber(body.target_reps ?? body.targetReps);
  if (targetSets === undefined && targetReps === undefined) {
    return badRequest("没带任何要改的字段（move / exercise_id / target_sets / target_reps）", undefined, request);
  }
  const recorded = countSetsOfExercise(db, sessionId, row.exerciseId);
  if (targetSets !== undefined) {
    if (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > 20) {
      return badRequest("target_sets 必须是 1~20 的整数", undefined, request);
    }
    if (targetSets < recorded) {
      return badRequest(`这个动作已经记了 ${recorded} 组，目标组数不能比它小`, undefined, request);
    }
  }
  if (targetReps !== undefined && (!Number.isInteger(targetReps) || targetReps < 1 || targetReps > 999)) {
    return badRequest("target_reps 必须是 1~999 的整数", undefined, request);
  }

  updateSessionExercise(db, seId, { targetSets, targetReps });
  const updated = sessionExerciseById(db, seId);
  return writeJson(request, {
    id: seId,
    targetSets: updated?.targetSets,
    targetReps: updated?.targetReps,
    recordedSets: recorded,
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const session = loadSession(sessionId);
  if (!session) return notFound("会话不存在");
  if (session.status === "done" || session.status === "aborted") {
    return closedResponse(sessionId, session.status, request);
  }

  const url = new URL(request.url);
  const seId = Number(url.searchParams.get("id"));
  const confirm = url.searchParams.get("confirm") === "1";
  if (!Number.isInteger(seId)) return badRequest("缺少 id", undefined, request);

  const db = getDb();
  const row = sessionExerciseById(db, seId);
  if (!row || row.sessionId !== sessionId) return notFound("这次会话里没有这一条动作");
  if (listCount(sessionId) <= 1) return badRequest("至少留一个动作（全不练就用「提前结束」）", undefined, request);

  const recorded = countSetsOfExercise(db, sessionId, row.exerciseId);
  if (recorded > 0 && !confirm) {
    return writeJson(request, 
      {
        error: `移出「${exerciseById(db, row.exerciseId)?.name ?? "这个动作"}」会把本次已记的 ${recorded} 组一起丢掉。`,
        removed: false,
        needs_confirm: true,
        sets: recorded,
      },
      { status: 409 },
    );
  }

  const result = removeSessionExercise(db, seId, { withSets: confirm });
  return writeJson(request, { id: seId, removed: result.removed, deletedSets: result.deletedSets });
}
