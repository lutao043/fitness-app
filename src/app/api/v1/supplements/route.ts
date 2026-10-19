/**
 * GET  /api/v1/supplements —— 补剂清单全量（含已停用的；维护界面用）
 * POST /api/v1/supplements —— 新增补剂
 *
 * FR-33：清单完全可增删改（名称 / 时点 / 剂量 / 排序 / 启用 / **适用日**（v1.49 / 13.21）），
 * 加一种补剂不用改代码。补剂打卡的唯一事实源是 `checkin(kind=supplement)`，这张表只管"清单"。
 */

import { getDb } from "@/db/client";
import { supplementsAll } from "@/db/queries";
import { createSupplement } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { parseSupplementBody } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  return json({ supplements: supplementsAll(getDb()) });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const supplementParsed = parseSupplementBody(parsed.body, { requireName: true });
  if (!supplementParsed.ok) return badRequest("补剂参数不合法", supplementParsed.issues, request);

  const created = createSupplement(getDb(), {
    name: supplementParsed.value.name!,
    times: supplementParsed.value.times ?? [],
    doseText: supplementParsed.value.doseText ?? "",
    enabled: supplementParsed.value.enabled ?? true,
    dayKind: supplementParsed.value.dayKind ?? "daily",
  });
  return writeJson(request, { id: created.id }, { status: 201 });
}
