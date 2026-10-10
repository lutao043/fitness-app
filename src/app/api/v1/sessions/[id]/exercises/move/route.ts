/**
 * POST /api/v1/sessions/{id}/exercises/move —— 「换动作」：把某动作本次已记的组整体搬到另一个动作（issue #43 / v1.46）。
 *
 * 与 `PATCH /exercises {exercise_id}`（换掉 = 连组一起删）不是一件事：
 * 这条是**修正记错的动作**，组一个不丢、**组间歇也不重算**（补录会把 `rest_before_sec` 变成 null，13.5）。
 *
 * 请求体：`{from_exercise_id, to_exercise_id}`
 * - `done`（已收工）也允许 —— 事后发现记错动作是合法修正；`aborted` → 400（与现有门禁一致）；
 * - 换成自己 → `changed: false`，无副作用；
 * - 返回 `{changed, movedSets, volumeBeforeKg, volumeAfterKg, targetHadRow}` 供确认弹窗与小结重算。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { exerciseById, moveExerciseSets } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asNumber, badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { refreshSessionSummary } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const db = getDb();
  const session = db.select().from(schema.workoutSession).where(eq(schema.workoutSession.id, sessionId)).get();
  if (!session) return notFound("会话不存在");
  if (session.status === "aborted") {
    return badRequest("这次会话已中断，不能再换动作", undefined, request);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const from = asNumber(parsed.body.from_exercise_id ?? parsed.body.fromExerciseId);
  const to = asNumber(parsed.body.to_exercise_id ?? parsed.body.toExerciseId);
  if (!from || !to) return badRequest("缺少 from_exercise_id / to_exercise_id", undefined, request);
  if (!exerciseById(db, to)) return badRequest("要换成的动作不存在", undefined, request);
  if (!exerciseById(db, from)) return badRequest("要搬走的动作不存在", undefined, request);

  const result = moveExerciseSets(db, { sessionId, fromExerciseId: from, toExerciseId: to });
  const summary = result.changed ? refreshSessionSummary(db, sessionId) : null;

  return writeJson(
    request,
    {
      changed: result.changed,
      fromExerciseId: from,
      toExerciseId: to,
      movedSets: result.movedSets,
      volumeBeforeKg: result.volumeBeforeKg,
      volumeAfterKg: result.volumeAfterKg,
      targetHadRow: result.targetHadRow,
      summary,
    },
    undefined,
    {
      change: result.changed
        ? {
            changed: true,
            from_exercise_id: from,
            to_exercise_id: to,
            moved_sets: result.movedSets,
            volume_before_kg: result.volumeBeforeKg,
            volume_after_kg: result.volumeAfterKg,
          }
        : { changed: false, from_exercise_id: from, to_exercise_id: to },
    },
  );
}
