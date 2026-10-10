/**
 * 读查询 · part1（issue #26 从 `db/queries.ts` 拆出；语义与拆分前逐字一致）。
 */

import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";
import type { LoadMode, LoadSemantics, ExerciseType } from "@/lib/exercise/types";
import type { WeightUnit } from "@/lib/units";
import { isTrainingDay } from "@/lib/schedule";
import type { ScheduleCtx, SlotLike } from "@/lib/schedule";
import { muscleGroups } from "@/lib/caliber/muscles";
import { holidayCoverageEnd, holidayCoverageEnough } from "@/lib/reminder/holiday-gap";

export interface VariantView {
  /** exercise_variant.id；null = 默认变体（动作本身） */
  id: number | null;
  code: string | null;
  equip: string;
  semantics: LoadSemantics;
  label: string;
  baseWeight: number | null;
  /** 这台器械的读数单位（v1.38）；null = 跟随全局设置（`effectiveReadUnit` 算生效值） */
  readUnit: WeightUnit | null;
}

export interface ExerciseView {
  exerciseId: number;
  name: string;
  type: ExerciseType;
  muscles: string[];
  groups: string[];
  equip: string;
  loadMode: LoadMode;
  barKg: number | null;
  baseWeight: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52）—— 训练页的倒计时按它起算 */
  restSec: number | null;
  note: string | null;
  homeOk: boolean;
  variants: VariantView[];
  /** 本次目标（来自槽位清单，或会话快照） */
  targetSets: number;
  targetReps: number;
}

export interface SlotView extends SlotLike {
  templateId: number;
  position: number;
  label: string;
  rest: boolean;
  muscles: string[];
  gym: ExerciseView[];
  home: ExerciseView[];
}

export interface ScheduleState {
  schemeId: string;
  schemeName: string;
  slots: SlotView[];
  anchor: { date: DateStr; position: number; reason: string };
  /** 只含 type = "holiday" 的日子（补班日是上班日、要占位，13.7） */
  holidaySet: Set<DateStr>;
  makeupSet: Set<DateStr>;
  skipSet: Set<DateStr>;
  holidays: { date: DateStr; name: string; type: "holiday" | "workday" }[];
  holidayCoverageEnd: DateStr | null;
  holidayCoverageEnough: boolean;
  ctx: ScheduleCtx;
}

function loadSlots(db: Db, schemeId: string): SlotView[] {
  const templates = db
    .select()
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, schemeId))
    .orderBy(asc(schema.cycleTemplate.position))
    .all();

  const exercises = db.select().from(schema.exercise).all();
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const variants = db.select().from(schema.exerciseVariant).orderBy(asc(schema.exerciseVariant.orderNo)).all();
  const variantByExercise = new Map<number, VariantView[]>();
  for (const v of variants) {
    const list = variantByExercise.get(v.exerciseId) ?? [];
    list.push({
      id: v.id,
      code: v.code,
      equip: v.equip,
      semantics: v.loadSemantics,
      label: v.label,
      baseWeight: v.baseWeight,
      readUnit: v.readUnit ?? null,
    });
    variantByExercise.set(v.exerciseId, list);
  }

  const rows = db
    .select()
    .from(schema.cycleExercise)
    .orderBy(asc(schema.cycleExercise.orderNo))
    .all();

  return templates.map((t) => {
    const toView = (mode: "gym" | "home"): ExerciseView[] =>
      rows
        .filter((r) => r.templateId === t.id && r.mode === mode)
        .map((r) => {
          const e = exById.get(r.exerciseId);
          if (!e) throw new Error(`cycle_exercise 引用了不存在的动作 id=${r.exerciseId}`);
          return {
            exerciseId: e.id,
            name: e.name,
            type: e.type,
            muscles: e.muscles,
            groups: muscleGroups(e.muscles),
            equip: e.equip,
            loadMode: e.loadMode,
            barKg: e.barKg,
            baseWeight: e.baseWeight,
            restSec: e.restSec,
            note: e.note,
            homeOk: e.homeOk,
            variants: variantByExercise.get(e.id) ?? [],
            targetSets: r.targetSets,
            targetReps: r.targetReps,
          };
        });
    return {
      templateId: t.id,
      position: t.position,
      label: t.name,
      rest: t.isRest,
      muscles: t.muscles,
      gym: toView("gym"),
      home: toView("home"),
    };
  });
}

export function loadScheduleState(db: Db, today: DateStr): ScheduleState {
  const activeScheme =
    db.select().from(schema.splitScheme).where(eq(schema.splitScheme.active, true)).get() ??
    db.select().from(schema.splitScheme).orderBy(asc(schema.splitScheme.orderNo)).get();
  if (!activeScheme) throw new Error("库里没有分化方案（种子未注入？）");

  const anchorRow = db
    .select()
    .from(schema.scheduleAnchor)
    .where(eq(schema.scheduleAnchor.schemeId, activeScheme.id))
    .orderBy(desc(schema.scheduleAnchor.id))
    .get();
  if (!anchorRow) throw new Error(`方案 ${activeScheme.id} 没有锚点记录`);

  const holidays = db.select().from(schema.holiday).orderBy(asc(schema.holiday.date)).all();
  const holidaySet = new Set<DateStr>();
  const makeupSet = new Set<DateStr>();
  for (const h of holidays) {
    if (h.type === "holiday") holidaySet.add(h.date);
    else makeupSet.add(h.date);
  }

  const skipRows = db.select({ date: schema.skipDay.date }).from(schema.skipDay).all();
  const skipSet = new Set(skipRows.map((s) => s.date));

  // 循环位点（13.17）：加练的顺延；按 (date, id) 升序装载，同一天多条取最后一条
  const pointRows = db
    .select({ date: schema.cyclePoint.date, position: schema.cyclePoint.position })
    .from(schema.cyclePoint)
    .where(eq(schema.cyclePoint.schemeId, activeScheme.id))
    .orderBy(asc(schema.cyclePoint.date), asc(schema.cyclePoint.id))
    .all();

  const slots = loadSlots(db, activeScheme.id);
  const coverageEnd = holidayCoverageEnd(holidays.map((h) => ({ date: h.date, type: h.type })));

  return {
    schemeId: activeScheme.id,
    schemeName: activeScheme.name,
    slots,
    anchor: { date: anchorRow.anchorDate, position: anchorRow.cyclePosition, reason: anchorRow.reason },
    holidaySet,
    makeupSet,
    skipSet,
    holidays: holidays.map((h) => ({ date: h.date, name: h.name, type: h.type })),
    holidayCoverageEnd: coverageEnd,
    holidayCoverageEnough: holidayCoverageEnough(coverageEnd, today),
    ctx: {
      anchor: { date: anchorRow.anchorDate, position: anchorRow.cyclePosition },
      holidays: holidaySet,
      skips: skipSet,
      cycleLen: slots.length,
      points: pointRows.map((p) => ({ date: p.date, position: p.position })),
    },
  };
}

/**
 * 某天的日子类型（13.11 的"加班判定只在训练日有意义"用它）：
 * 法定节假日 > 循环位「休」> 训练日。加练/顺延不改变这个判断（只影响排期位次）。
 */
export type DayKind = "training" | "rest" | "holiday";

export function dayKindOf(date: DateStr, state: ScheduleState): DayKind {
  if (state.holidaySet.has(date)) return "holiday";
  return isTrainingDay(date, state.ctx, state.slots) ? "training" : "rest";
}

/* ————————————— 规则管理（v1.2 规则管理界面：方案 / 槽位 / 动作库 / 补剂） ————————————— */
export interface SchemeAdminView {
  id: string;
  name: string;
  note: string;
  orderNo: number;
  active: boolean;
  slots: SlotView[];
  /** 生效锚点（该方案最新一条，只追加不修改） */
  anchor: { date: DateStr; position: number; reason: string } | null;
}

/** 方案编辑页的数据源：所有方案 + 各自的槽位（含两套动作清单）+ 生效锚点 */
export function schemesAdmin(db: Db): SchemeAdminView[] {
  const schemes = db
    .select()
    .from(schema.splitScheme)
    .orderBy(asc(schema.splitScheme.orderNo), asc(schema.splitScheme.id))
    .all();
  return schemes.map((s) => {
    const anchorRow =
      db
        .select()
        .from(schema.scheduleAnchor)
        .where(eq(schema.scheduleAnchor.schemeId, s.id))
        .orderBy(desc(schema.scheduleAnchor.id))
        .get() ?? null;
    return {
      id: s.id,
      name: s.name,
      note: s.note,
      orderNo: s.orderNo,
      active: !!s.active,
      slots: loadSlots(db, s.id),
      anchor: anchorRow
        ? { date: anchorRow.anchorDate, position: anchorRow.cyclePosition, reason: anchorRow.reason }
        : null,
    };
  });
}

export interface ExerciseVariantRow {
  id: number;
  code: string;
  equip: string;
  semantics: LoadSemantics;
  label: string;
  baseWeight: number | null;
  /** 读数单位（v1.38）：null = 跟随全局设置 */
  readUnit: WeightUnit | null;
}

export interface ExerciseLibraryRow {
  id: number;
  name: string;
  muscles: string[];
  groups: string[];
  type: ExerciseType;
  equip: string;
  loadMode: LoadMode;
  barKg: number | null;
  defaultSets: number;
  defaultReps: number;
  baseWeight: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52） */
  restSec: number | null;
  homeOk: boolean;
  note: string | null;
  orderNo: number;
  variants: ExerciseVariantRow[];
  /** 被几个槽位引用 / 有几组历史记录（删除前的提示与拦截依据） */
  templateRefs: number;
  setCount: number;
}

/** 动作库（维护界面用）：全量 + 变体 + 引用计数 */
export function exerciseLibrary(db: Db): ExerciseLibraryRow[] {
  const exercises = db.select().from(schema.exercise).orderBy(asc(schema.exercise.orderNo)).all();
  const variants = db
    .select()
    .from(schema.exerciseVariant)
    .orderBy(asc(schema.exerciseVariant.orderNo))
    .all();
  const byExercise = new Map<number, ExerciseVariantRow[]>();
  for (const v of variants) {
    const list = byExercise.get(v.exerciseId) ?? [];
    list.push({
      id: v.id,
      code: v.code,
      equip: v.equip,
      semantics: v.loadSemantics,
      label: v.label,
      baseWeight: v.baseWeight,
      readUnit: v.readUnit ?? null,
    });
    byExercise.set(v.exerciseId, list);
  }
  const templateRefs = new Map<number, number>();
  for (const r of db
    .select({ exerciseId: schema.cycleExercise.exerciseId })
    .from(schema.cycleExercise)
    .all()) {
    templateRefs.set(r.exerciseId, (templateRefs.get(r.exerciseId) ?? 0) + 1);
  }
  const setCounts = new Map<number, number>();
  for (const r of db
    .select({ exerciseId: schema.setLog.exerciseId, n: sql<number>`count(*)` })
    .from(schema.setLog)
    .groupBy(schema.setLog.exerciseId)
    .all()) {
    setCounts.set(r.exerciseId, Number(r.n));
  }

  return exercises.map((e) => ({
    id: e.id,
    name: e.name,
    muscles: e.muscles,
    groups: muscleGroups(e.muscles),
    type: e.type,
    equip: e.equip,
    loadMode: e.loadMode,
    barKg: e.barKg,
    defaultSets: e.defaultSets,
    defaultReps: e.defaultReps,
    baseWeight: e.baseWeight,
    restSec: e.restSec,
    homeOk: !!e.homeOk,
    note: e.note,
    orderNo: e.orderNo,
    variants: byExercise.get(e.id) ?? [],
    templateRefs: templateRefs.get(e.id) ?? 0,
    setCount: setCounts.get(e.id) ?? 0,
  }));
}

/** 一级键 = 动作 id，二级键 = 变体（null → "default"） */
export type SetHistoryMap = Map<number, Map<string, SetRowView>>;

export interface SetRowView {
  exerciseId: number;
  exerciseName: string;
  variantId: number | null;
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  durationSec: number | null;
  totalLoadKg: number | null;
  restBeforeSec: number | null;
  sameExercise: boolean;
  doneAt: string;
  feel: string | null;
}
