/**
 * PATCH  /api/v1/schemes/{id}/slots/{templateId} —— 改槽位（名字 / 是不是「休」/ 肌群 / 上下挪一位）
 * DELETE /api/v1/schemes/{id}/slots/{templateId} —— 删槽位（每个方案至少留一个）
 *
 * 槽位名同方案内唯一；排序用 `{move: "up" | "down"}`（与相邻槽位换位，保持 position 连续）。
 */

import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { deleteSlot, moveSlot, schemeById, templateById, updateSlot } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asString, badRequest, notFound, oneOf, readJsonBody, writeJson } from "@/server/http";
import { parseSlotBody } from "@/server/rules";
import { and, eq, ne } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; templateId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const params = await ctx.params;
  const templateId = Number(params.templateId);
  if (!Number.isInteger(templateId)) return badRequest("槽位 id 不合法", undefined, request);

  const db = getDb();
  const slot = templateById(db, templateId);
  if (!slot || slot.schemeId !== params.id) return notFound("槽位不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const move = oneOf(body.move, ["up", "down"] as const);
  if (move) {
    const result = moveSlot(db, templateId, move === "up" ? -1 : 1);
    return writeJson(request, { id: templateId, moved: result.moved });
  }

  const slotParsed = parseSlotBody(body, { requireName: false });
  if (!slotParsed.ok) return badRequest("槽位参数不合法", slotParsed.issues, request);
  if (slotParsed.value.name && slotParsed.value.name !== slot.name) {
    const clash = db
      .select()
      .from(schema.cycleTemplate)
      .where(
        and(
          eq(schema.cycleTemplate.schemeId, slot.schemeId),
          eq(schema.cycleTemplate.name, slotParsed.value.name),
          ne(schema.cycleTemplate.id, templateId),
        ),
      )
      .get();
    if (clash) return badRequest("同一方案里已有同名槽位", undefined, request);
  }

  updateSlot(db, templateId, slotParsed.value);
  const updated = templateById(db, templateId);
  return writeJson(request, { id: templateId, name: updated?.name, rest: !!updated?.isRest, muscles: updated?.muscles ?? [] });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; templateId: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const params = await ctx.params;
  const templateId = Number(params.templateId);
  if (!Number.isInteger(templateId)) return badRequest("槽位 id 不合法", undefined, request);
  const db = getDb();
  const slot = templateById(db, templateId);
  if (!slot || slot.schemeId !== params.id) return notFound("槽位不存在");
  if (!schemeById(db, params.id)) return notFound("方案不存在");

  const result = deleteSlot(db, templateId);
  if (!result.removed) return badRequest(result.error ?? "删不掉", undefined, request);
  return writeJson(request, { id: templateId, removed: true, schemeId: asString(params.id) });
}
