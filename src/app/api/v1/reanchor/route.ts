/**
 * POST /api/v1/reanchor —— 重锚（FR-23 / FR-38）：`{date, cycle_position, reason}`。
 *
 * **禁止自动重锚**（踩坑第 13 条）：这个接口只在用户确认后调用；
 * 同参数幂等 —— 只追加一条锚历史，不修改旧记录（第 6 章要点）。
 */

import { getDb } from "@/db/client";
import { activeSchemeId, appendAnchor } from "@/db/writes";
import { loadScheduleStateCheck } from "@/server/reanchor";
import { requireApiAuth } from "@/server/auth";
import { asString, badRequest, readJsonBody, writeJson } from "@/server/http";
import { parseReanchorBody } from "@/server/rules";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const db = getDb();
  const schemeId = asString(parsed.body.scheme_id ?? parsed.body.schemeId) ?? activeSchemeId(db);
  const slots = loadScheduleStateCheck(db, schemeId);

  // date 格式与 cycle_position 范围（0..槽位数-1）都收敛在 server/rules.ts（13.19 的范围表）
  const reanchor = parseReanchorBody(parsed.body, { defaultDate: dateInTz(), cycleLen: slots });
  if (!reanchor.ok) return badRequest(reanchor.issues.join("；"), undefined, request);
  const { date, cyclePosition, reason, note } = reanchor.value;

  const result = appendAnchor(db, {
    schemeId,
    anchorDate: date,
    cyclePosition,
    reason,
    note,
  });

  return writeJson(request, { id: result.id, date, cyclePosition, schemeId }, { status: 201 });
}
