/**
 * POST /api/v1/schemes/{id}/slots —— 给方案加一个槽位（加在末尾）
 *
 * 槽位名在同一方案内唯一（第 6 章数据模型）；循环长度 = 槽位数，所以「休」也要占一个槽位。
 */

import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addSlot, schemeById } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseSlotBody } from "@/server/rules";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const db = getDb();
  if (!schemeById(db, id)) return notFound("方案不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const slotParsed = parseSlotBody(parsed.body, { requireName: true });
  if (!slotParsed.ok) return badRequest("槽位参数不合法", slotParsed.issues, request);
  const name = slotParsed.value.name!;

  const siblings = db
    .select()
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, id))
    .all();
  if (siblings.some((s) => s.name === name)) return badRequest("同一方案里已有同名槽位", undefined, request);
  if (siblings.length >= 14) return badRequest("槽位最多 14 个（循环太长就没有意义了）", undefined, request);

  const created = addSlot(db, {
    schemeId: id,
    name,
    isRest: slotParsed.value.isRest,
    muscles: slotParsed.value.muscles ?? [],
  });
  return writeJson(request, { id: created.id, schemeId: id, name, isRest: !!slotParsed.value.isRest }, { status: 201 });
}
