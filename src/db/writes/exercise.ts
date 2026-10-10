/**
 * 幂等写入口 · exercise（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { LoadMode, LoadSemantics } from "@/lib/exercise/types";
import type { WeightUnit } from "@/lib/units";

/* ———————————————————————— 规则管理：动作库与器械变体（3.1 / 13.14 / FR-49） ———————————————————————— */

export interface ExerciseWriteInput {
  name: string;
  muscles: string[];
  type: "weight" | "reps" | "time";
  equip: string;
  loadMode: LoadMode;
  barKg?: number | null;
  defaultSets: number;
  defaultReps: number;
  baseWeight?: number | null;
  /** 动作级默认组间歇（秒，10~600）；空 = 全局默认（FR-52） */
  restSec?: number | null;
  homeOk?: boolean;
  note?: string | null;
}

export function exerciseByName(db: Db, name: string, exceptId?: number) {
  const row = db.select().from(schema.exercise).where(eq(schema.exercise.name, name)).get() ?? null;
  if (row && row.id !== exceptId) return row;
  return null;
}

export function exerciseById(db: Db, id: number) {
  return db.select().from(schema.exercise).where(eq(schema.exercise.id, id)).get() ?? null;
}

export function createExercise(db: Db, input: ExerciseWriteInput): { id: number } {
  const maxOrder = db
    .select({ orderNo: schema.exercise.orderNo })
    .from(schema.exercise)
    .all()
    .reduce((m, r) => Math.max(m, r.orderNo), -1);
  return db
    .insert(schema.exercise)
    .values({
      name: input.name,
      muscles: input.muscles,
      type: input.type,
      equip: input.equip,
      loadMode: input.loadMode,
      barKg: input.barKg ?? null,
      defaultSets: input.defaultSets,
      defaultReps: input.defaultReps,
      baseWeight: input.baseWeight ?? null,
      restSec: input.restSec ?? null,
      homeOk: !!input.homeOk,
      note: input.note ?? null,
      orderNo: maxOrder + 1,
    })
    .returning({ id: schema.exercise.id })
    .get();
}

export function updateExercise(db: Db, id: number, patch: Partial<ExerciseWriteInput>): { updated: boolean } {
  const values: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: "name",
    muscles: "muscles",
    type: "type",
    equip: "equip",
    loadMode: "loadMode",
    barKg: "barKg",
    defaultSets: "defaultSets",
    defaultReps: "defaultReps",
    baseWeight: "baseWeight",
    restSec: "restSec",
    homeOk: "homeOk",
    note: "note",
  };
  for (const [key, column] of Object.entries(map)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) values[column] = value;
  }
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.exercise).set(values).where(eq(schema.exercise.id, id)).run();
  return { updated: res.changes > 0 };
}

/**
 * 删动作：有历史记录（组记录 / 会话快照引用）就**不删**，如实告诉用户 ——
 * 历史是主键引用（`set_log.exercise_id`），删掉动作会让历史悬空。
 * 没有历史时，连同「各方案槽位里的引用」一起清掉（原型 §4.3 的约定）。
 */
export function deleteExercise(db: Db, id: number): { removed: boolean; error?: string; usedBy: number; templates: number } {
  const exercise = exerciseById(db, id);
  if (!exercise) return { removed: false, error: "动作不存在", usedBy: 0, templates: 0 };
  const setCount = db.select({ id: schema.setLog.id }).from(schema.setLog).where(eq(schema.setLog.exerciseId, id)).all().length;
  const sessionCount = db
    .select({ id: schema.sessionExercise.id })
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.exerciseId, id))
    .all().length;
  const templateRefs = db
    .select({ id: schema.cycleExercise.id })
    .from(schema.cycleExercise)
    .where(eq(schema.cycleExercise.exerciseId, id))
    .all().length;
  if (setCount > 0 || sessionCount > 0) {
    return {
      removed: false,
      error: `这个动作有 ${setCount} 组历史记录（${sessionCount} 处训练引用），删掉会让历史悬空 —— 先从方案里移除就够了`,
      usedBy: setCount,
      templates: templateRefs,
    };
  }
  db.transaction((tx) => {
    tx.delete(schema.cycleExercise).where(eq(schema.cycleExercise.exerciseId, id)).run();
    tx.delete(schema.exercise).where(eq(schema.exercise.id, id)).run();
  });
  return { removed: true, usedBy: 0, templates: templateRefs };
}

export function variantById(db: Db, id: number) {
  return db.select().from(schema.exerciseVariant).where(eq(schema.exerciseVariant.id, id)).get() ?? null;
}

export function addVariant(
  db: Db,
  input: {
    exerciseId: number;
    equip: string;
    semantics: LoadSemantics;
    label?: string;
    baseWeight?: number | null;
    /** 这台器械的读数单位（v1.38 / issue #36）：null / 缺省 = 跟随全局设置 */
    readUnit?: WeightUnit | null;
  },
): { id: number } {
  const existing = db
    .select()
    .from(schema.exerciseVariant)
    .where(eq(schema.exerciseVariant.exerciseId, input.exerciseId))
    .orderBy(asc(schema.exerciseVariant.orderNo))
    .all();
  const code = `v-${Math.random().toString(36).slice(2, 8)}`;
  return db
    .insert(schema.exerciseVariant)
    .values({
      exerciseId: input.exerciseId,
      code,
      equip: input.equip,
      loadSemantics: input.semantics,
      label: input.label ?? "",
      orderNo: existing.length,
      baseWeight: input.baseWeight ?? null,
      readUnit: input.readUnit ?? null,
    })
    .returning({ id: schema.exerciseVariant.id })
    .get();
}

export function updateVariant(
  db: Db,
  id: number,
  patch: {
    equip?: string;
    semantics?: LoadSemantics;
    label?: string;
    baseWeight?: number | null;
    /** 读数单位（v1.38）：显式传 null = 改回"跟随全局" */
    readUnit?: WeightUnit | null;
  },
): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.equip !== undefined) values.equip = patch.equip;
  if (patch.semantics !== undefined) values.loadSemantics = patch.semantics;
  if (patch.label !== undefined) values.label = patch.label;
  if (patch.baseWeight !== undefined) values.baseWeight = patch.baseWeight;
  if (patch.readUnit !== undefined) values.readUnit = patch.readUnit;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.exerciseVariant).set(values).where(eq(schema.exerciseVariant.id, id)).run();
  return { updated: res.changes > 0 };
}

/** 删变体：已经被记录引用过就不删（删了那些组的读数语义会变回默认变体） */
export function deleteVariant(db: Db, id: number): { removed: boolean; error?: string; usedBy: number } {
  const variant = variantById(db, id);
  if (!variant) return { removed: false, error: "变体不存在", usedBy: 0 };
  const used = db.select({ id: schema.setLog.id }).from(schema.setLog).where(eq(schema.setLog.variantId, id)).all().length;
  if (used > 0) {
    return { removed: false, error: `这个变体已经有 ${used} 组记录（读数语义按变体存），改它就行、别删`, usedBy: used };
  }
  db.delete(schema.exerciseVariant).where(eq(schema.exerciseVariant.id, id)).run();
  return { removed: true, usedBy: 0 };
}
