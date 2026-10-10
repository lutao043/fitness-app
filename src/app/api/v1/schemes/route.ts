/**
 * GET  /api/v1/schemes —— 全部分化方案 + 各方案的槽位（含健身房 / 居家两套动作清单）+ 生效锚点
 * POST /api/v1/schemes —— 新建方案（`copy_from` 给 id 时复制那套的槽位与清单）
 *
 * 方案是排期引擎的输入（3.1：循环长度 = 槽位数）；新建时记一条 `initial` 锚点，
 * 首次真正启用从第 1 位开始（`switchActiveScheme` 的语义见 db/writes.ts）。
 */

import { getDb } from "@/db/client";
import { schemesAdmin } from "@/db/queries";
import * as schema from "@/db/schema";
import { createScheme, schemeById } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asString, badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { parseSchemeBody } from "@/server/rules";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  const schemes = schemesAdmin(getDb());
  return json({
    schemes,
    activeSchemeId: schemes.find((s) => s.active)?.id ?? schemes[0]?.id ?? null,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const nameParsed = parseSchemeBody(body, { requireName: true });
  if (!nameParsed.ok) return badRequest("方案参数不合法", nameParsed.issues, request);
  const name = nameParsed.value.name!;

  const db = getDb();
  const all = db.select().from(schema.splitScheme).all();
  if (all.some((s) => s.name === name)) return badRequest("已经有同名方案了", undefined, request);

  const copyFrom = asString(body.copy_from ?? body.copyFrom) ?? null;
  if (copyFrom && !schemeById(db, copyFrom)) return badRequest("要复制的方案不存在", undefined, request);

  const id = `scheme-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  createScheme(db, { id, name, note: nameParsed.value.note, copyFrom, anchorDate: dateInTz() });
  return writeJson(request, { id, name, copiedFrom: copyFrom }, { status: 201 });
}
