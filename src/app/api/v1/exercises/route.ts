/**
 * GET  /api/v1/exercises —— 动作库全量（含器械变体与引用计数；规则管理界面与开练选动作共用）
 * POST /api/v1/exercises —— 新增动作
 *
 * 动作清单必须可编辑（3.1）；器械是**变体的属性**，不要拼进动作名（13.14 / 踩坑第 31 条）。
 * 动作名唯一（第 6 章）：历史记录引用的是 `exercise_id`，改名不动历史。
 */

import { getDb } from "@/db/client";
import { exerciseLibrary } from "@/db/queries";
import { createExercise, exerciseByName } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { parseExerciseBody, EQUIPS, EXERCISE_TYPES, FINE_MUSCLES, LOAD_MODES, SEMANTICS } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  return json({
    exercises: exerciseLibrary(getDb()),
    /** 词表随数据一起下发（客户端组件不 import 服务端种子数据，避免把 91 条动作打进包） */
    taxonomy: {
      muscles: FINE_MUSCLES,
      equips: EQUIPS,
      semantics: SEMANTICS,
      types: EXERCISE_TYPES,
      loadModes: LOAD_MODES,
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const exerciseParsed = parseExerciseBody(parsed.body, { requireAll: true });
  if (!exerciseParsed.ok) return badRequest("动作参数不合法", exerciseParsed.issues, request);
  const value = exerciseParsed.value;

  const db = getDb();
  if (exerciseByName(db, value.name!)) return badRequest(`动作库里已经有「${value.name}」了`, undefined, request);

  const created = createExercise(db, {
    name: value.name!,
    muscles: value.muscles!,
    type: value.type!,
    equip: value.equip!,
    loadMode: value.loadMode!,
    barKg: value.barKg ?? null,
    defaultSets: value.defaultSets!,
    defaultReps: value.defaultReps!,
    baseWeight: value.baseWeight ?? null,
    restSec: value.restSec ?? null,
    homeOk: value.homeOk ?? false,
    note: value.note ?? null,
  });
  return writeJson(request, { id: created.id, name: value.name }, { status: 201 });
}
