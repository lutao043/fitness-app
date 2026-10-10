/**
 * POST /api/v1/exercises/{id}/variants —— 给动作加一个器械变体（13.14 / FR-49）
 *
 * 变体 = 器械 + 读数语义 + 备注（如「龙门架 + 下拉杆」）；默认变体就是动作本身（键 = 裸动作名），
 * 所以这里只管额外的变体。变更后「上次重量 / 常用 / PR / 趋势 / 历史分组」按新变体各算各的。
 */

import { getDb } from "@/db/client";
import { addVariant, exerciseById, variantById } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseVariantBody } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const exerciseId = Number(rawId);
  if (!Number.isInteger(exerciseId)) return badRequest("动作 id 不合法", undefined, request);
  const db = getDb();
  if (!exerciseById(db, exerciseId)) return notFound("动作不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const variantParsed = parseVariantBody(parsed.body, { requireAll: true });
  if (!variantParsed.ok) return badRequest("变体参数不合法", variantParsed.issues, request);

  const created = addVariant(db, {
    exerciseId,
    equip: variantParsed.value.equip!,
    semantics: variantParsed.value.semantics!,
    label: variantParsed.value.label ?? "",
    baseWeight: variantParsed.value.baseWeight ?? null,
    readUnit: variantParsed.value.readUnit ?? null,
  });
  const row = variantById(db, created.id);
  return writeJson(request, { id: created.id, code: row?.code, exerciseId }, { status: 201 });
}
