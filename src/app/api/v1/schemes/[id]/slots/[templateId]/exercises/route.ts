/**
 * PUT /api/v1/schemes/{id}/slots/{templateId}/exercises —— 覆盖槽位某一套动作清单
 *
 * `{mode: "gym" | "home", exercises: [{exercise_id, sets, reps}]}`：**整表原子覆盖**、顺序 = 数组顺序。
 * 只动这个槽位的这一套清单（健身房 / 居家自重各自独立），历史记录与进行中的会话不受影响
 * （会话有 plan_snapshot，改模板不改已开的会话）。
 */

import { getDb } from "@/db/client";
import { exerciseById, replaceSlotExercises, templateById } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { parseSlotExercises } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, ctx: { params: Promise<{ id: string; templateId: string }> }) {
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
  const listParsed = parseSlotExercises(parsed.body);
  if (!listParsed.ok) return badRequest("动作清单不合法", listParsed.issues, request);

  const missing = listParsed.value.list.filter((entry) => !exerciseById(db, entry.exerciseId));
  if (missing.length > 0) {
    return badRequest(`动作库里没有这些 id：${missing.map((m) => m.exerciseId).join(", ")}`, undefined, request);
  }

  // 提醒：type=time 的动作目标写的是秒数、reps 写的是次数，这里只做范围校验，不做类型推断
  const result = replaceSlotExercises(db, templateId, listParsed.value.mode, listParsed.value.list);
  return writeJson(request, { templateId, mode: listParsed.value.mode, count: result.count });
}
