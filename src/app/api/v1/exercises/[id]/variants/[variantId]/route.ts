/**
 * PATCH  /api/v1/exercises/{id}/variants/{variantId} —— 改变体（器械 / 读数语义 / 备注 / 参考重量）
 * DELETE /api/v1/exercises/{id}/variants/{variantId} —— 删变体
 *
 * 已经被记录引用过的变体**不删**（那些组的读数语义按变体存着）：改成对的那台就行。
 */

import { getDb } from "@/db/client";
import { exerciseById, updateVariant, variantById, deleteVariant } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseVariantBody } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; variantId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const params = await ctx.params;
  const exerciseId = Number(params.id);
  const variantId = Number(params.variantId);
  if (!Number.isInteger(exerciseId) || !Number.isInteger(variantId)) {
    return badRequest("id 不合法", undefined, request);
  }
  const db = getDb();
  const variant = variantById(db, variantId);
  if (!variant || variant.exerciseId !== exerciseId) return notFound("变体不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const variantParsed = parseVariantBody(parsed.body, { requireAll: false });
  if (!variantParsed.ok) return badRequest("变体参数不合法", variantParsed.issues, request);

  updateVariant(db, variantId, variantParsed.value);
  const updated = variantById(db, variantId);
  return writeJson(request, {
    id: variantId,
    equip: updated?.equip,
    semantics: updated?.loadSemantics,
    label: updated?.label,
    baseWeight: updated?.baseWeight ?? null,
    readUnit: updated?.readUnit ?? null,
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; variantId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const params = await ctx.params;
  const exerciseId = Number(params.id);
  const variantId = Number(params.variantId);
  if (!Number.isInteger(exerciseId) || !Number.isInteger(variantId)) {
    return badRequest("id 不合法", undefined, request);
  }
  const db = getDb();
  const variant = variantById(db, variantId);
  if (!variant || variant.exerciseId !== exerciseId) return notFound("变体不存在");
  if (!exerciseById(db, exerciseId)) return notFound("动作不存在");

  const result = deleteVariant(db, variantId);
  if (!result.removed) return badRequest(result.error ?? "删不掉", undefined, request);
  return writeJson(request, { id: variantId, removed: true });
}
