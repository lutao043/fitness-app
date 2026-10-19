/**
 * PATCH  /api/v1/supplements/{id} —— 改补剂（名称 / 时点 / 剂量 / 启用 / 适用日（v1.49）；`{move:"up"|"down"}` 调顺序）
 * DELETE /api/v1/supplements/{id} —— 删补剂（顺手清掉今天及以后尚未投递的补剂提醒事件）
 *
 * 改完立即生效（FR-40 同源）：提醒 tick 每次读的就是这张表，没有缓存。
 */

import { getDb } from "@/db/client";
import { supplementById, updateSupplement, deleteSupplement, moveSupplement } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, oneOf, readJsonBody, writeJson } from "@/server/http";
import { parseSupplementBody } from "@/server/rules";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("补剂 id 不合法", undefined, request);

  const db = getDb();
  if (!supplementById(db, id)) return notFound("补剂不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const move = oneOf(body.move, ["up", "down"] as const);
  if (move) {
    const result = moveSupplement(db, id, move === "up" ? -1 : 1);
    const updated = supplementById(db, id);
    return writeJson(request, { id, moved: result.moved, orderNo: updated?.orderNo });
  }

  const supplementParsed = parseSupplementBody(body, { requireName: false });
  if (!supplementParsed.ok) return badRequest("补剂参数不合法", supplementParsed.issues, request);

  updateSupplement(db, id, supplementParsed.value);
  const updated = supplementById(db, id);
  return writeJson(request, {
    id,
    name: updated?.name,
    times: updated?.times ?? [],
    doseText: updated?.doseText,
    enabled: !!updated?.enabled,
    dayKind: updated?.dayKind,
  });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("补剂 id 不合法", undefined, request);

  const db = getDb();
  if (!supplementById(db, id)) return notFound("补剂不存在");
  deleteSupplement(db, id, dateInTz());
  return writeJson(request, { id, removed: true });
}
