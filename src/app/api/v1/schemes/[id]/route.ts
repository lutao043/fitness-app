/**
 * PATCH  /api/v1/schemes/{id} —— 改名 / 改说明 / **切换当前方案**（`{active: true}`）
 * DELETE /api/v1/schemes/{id} —— 删方案（当前方案删不了，且至少要留一套）
 *
 * 切换的锚点语义（设计说明 §4.6「切回来原样恢复」）：切走给旧方案留一条 `switch_away` 锚点，
 * 切回时按那条的位次以今天重锚。**并行期（10.1）请保持默认方案不切**，否则与助手的连续循环会错位。
 */

import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { deleteScheme, schemeById, switchActiveScheme, updateScheme } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asBool, badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseSchemeBody } from "@/server/rules";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const db = getDb();
  const scheme = schemeById(db, id);
  if (!scheme) return notFound("方案不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (asBool(body.active) === true) {
    const result = switchActiveScheme(db, id, dateInTz());
    return writeJson(request, { id, active: true, ...result });
  }

  const nameParsed = parseSchemeBody(body, { requireName: false });
  if (!nameParsed.ok) return badRequest("方案参数不合法", nameParsed.issues, request);
  if (nameParsed.value.name) {
    const clash = db.select().from(schema.splitScheme).all().find((s) => s.name === nameParsed.value.name && s.id !== id);
    if (clash) return badRequest("已经有同名方案了", undefined, request);
  }

  updateScheme(db, id, nameParsed.value);
  const updated = schemeById(db, id);
  return writeJson(request, { id, name: updated?.name, note: updated?.note });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  const { id } = await ctx.params;
  const result = deleteScheme(getDb(), id);
  if (!result.removed) return badRequest(result.error ?? "删不掉", undefined, request);
  return writeJson(request, { id, removed: true });
}
