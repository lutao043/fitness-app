/**
 * POST /api/v1/schemes/import —— 导入一份方案 JSON（FR-54）。
 *
 * 语义（需求书 FR-54）：
 * - **只新建**：建一套新方案（不覆盖同名方案、不自动切换当前方案）；
 * - 动作按**名字**匹配（id 是本地的、跨设备不能用）；缺动作 **整单拒绝** 并列出名字 ——
 *   不做"部分导入"，半套清单比导入失败更难查；
 * - 形状与范围校验在 `server/rules.ts`（parseSchemeImportBody），这里只负责解析名字 → id 与落库。
 */

import { getDb } from "@/db/client";
import { schemesAdmin } from "@/db/queries";
import { addSlot, createScheme, exerciseByName, replaceSlotExercises } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, readJsonBody, writeJson } from "@/server/http";
import { parseSchemeImportBody } from "@/server/rules";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  const shape = parseSchemeImportBody(parsed.body);
  if (!shape.ok) return badRequest("方案 JSON 不合法", shape.issues, request);
  const { name, note, slots } = shape.value;

  const db = getDb();
  if (schemesAdmin(db).some((s) => s.name === name)) {
    return badRequest(`已经有叫「${name}」的方案了 —— 导入前先把方案名改一下`, undefined, request);
  }

  // 动作名 → id（缺一个就整单拒绝，如实列出哪些名字库里没有）
  const allNames = [...new Set(slots.flatMap((s) => [...s.gym, ...s.home]).map((e) => e.name))];
  const missing: string[] = [];
  const idByName = new Map<string, number>();
  for (const exerciseName of allNames) {
    const row = exerciseByName(db, exerciseName);
    if (!row) missing.push(exerciseName);
    else idByName.set(exerciseName, row.id);
  }
  if (missing.length > 0) {
    return badRequest(`动作库里没有这些动作，先在「我的 → 动作库」里建好再导入：${missing.join("、")}`, missing, request);
  }

  const id = `scheme-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  createScheme(db, { id, name, note, copyFrom: null, anchorDate: dateInTz() });

  const created: { templateId: number; label: string; gym: number; home: number }[] = [];
  for (const slot of slots) {
    const template = addSlot(db, {
      schemeId: id,
      name: slot.label,
      isRest: slot.rest,
      muscles: slot.muscles,
    });
    const toEntries = (list: typeof slot.gym) =>
      list.map((e) => ({ exerciseId: idByName.get(e.name)!, targetSets: e.sets, targetReps: e.reps }));
    replaceSlotExercises(db, template.id, "gym", toEntries(slot.gym));
    replaceSlotExercises(db, template.id, "home", toEntries(slot.home));
    created.push({ templateId: template.id, label: slot.label, gym: slot.gym.length, home: slot.home.length });
  }

  return writeJson(request, { id, name, slots: created }, { status: 201 });
}
