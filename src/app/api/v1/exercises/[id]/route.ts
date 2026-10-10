/**
 * PATCH  /api/v1/exercises/{id} —— 改动作（名称 / 肌群 / 类型 / 器械 / 读数口径 / 参考重量 / 备注）
 * DELETE /api/v1/exercises/{id} —— 删动作
 *
 * 删除的取舍（3.1「动作清单必须可编辑」+ 第 6 章主键引用）：
 * - 有历史记录（组记录 / 会话快照）→ **不删**，如实返回原因，让用户从方案里移除就够了；
 * - 没有历史 → 连同各方案槽位里的引用一起清掉（原型 §4.3 的约定）。
 * 改名不影响历史：`set_log` 引用的是 `exercise_id`。
 */

import { getDb } from "@/db/client";
import { exerciseById, exerciseByName, updateExercise, deleteExercise } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseExerciseBody } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("动作 id 不合法", undefined, request);

  const db = getDb();
  const existing = exerciseById(db, id);
  if (!existing) return notFound("动作不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const exerciseParsed = parseExerciseBody(parsed.body, { requireAll: false });
  if (!exerciseParsed.ok) return badRequest("动作参数不合法", exerciseParsed.issues, request);

  const value = exerciseParsed.value;
  if (value.name && value.name !== existing.name && exerciseByName(db, value.name, id)) {
    return badRequest(`动作库里已经有「${value.name}」了`, undefined, request);
  }

  updateExercise(db, id, value);
  const updated = exerciseById(db, id);
  return writeJson(request, { id, name: updated?.name, updated: true });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("动作 id 不合法", undefined, request);

  const before = exerciseById(getDb(), id);
  const result = deleteExercise(getDb(), id);
  if (!result.removed) return badRequest(result.error ?? "删不掉", undefined, request);
  return writeJson(
    request,
    { id, removed: true, templateRefs: result.templates },
    undefined,
    // 删除类记 **before 值**（issue #40 验收 3）
    {
      change: before
        ? { id, removed: true, name: before.name, equip: before.equip, loadMode: before.loadMode }
        : { id, removed: true },
    },
  );
}
