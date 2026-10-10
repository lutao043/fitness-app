/**
 * 读查询 · part3（issue #26 从 `db/queries.ts` 拆出；语义与拆分前逐字一致）。
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";
import { formatCn, timeInTz } from "@/lib/time";
import { isTrainingDay, slotIndexAt, slotOf } from "@/lib/schedule";
import { cheatDaysSince, cheatNext } from "@/lib/caliber/cheat";
import { earliestOvertime, overtimeVerdict } from "@/lib/overtime";
import type { TodayFacts } from "./part2";
import type { VariantView } from "./part1";
import { cardioList, overtimesOn, sessionsOn } from "./part2";
import { loadScheduleState } from "./part1";

export function latestBodyMetric(db: Db, today: DateStr) {
  // 大数字优先显示 morning，没有才退 bedtime（13.2）
  const morning = db
    .select()
    .from(schema.bodyMetric)
    .where(eq(schema.bodyMetric.slot, "morning"))
    .orderBy(desc(schema.bodyMetric.date))
    .get();
  const any = db
    .select()
    .from(schema.bodyMetric)
    .orderBy(desc(schema.bodyMetric.date))
    .get();
  const todayMorning = db
    .select()
    .from(schema.bodyMetric)
    .where(and(eq(schema.bodyMetric.date, today), eq(schema.bodyMetric.slot, "morning")))
    .get();
  return { latestMorning: todayMorning ?? morning ?? null, latestAny: any ?? null };
}

/** 训练结束 6 小时内的回执（13.3）：避免练完看首页收到"今天该练背"这种荒谬感 */
export function recentSessionReceipt(db: Db, now: number, hours = 6) {
  const row = db
    .select()
    .from(schema.workoutSession)
    .where(and(eq(schema.workoutSession.status, "done"), isNotNull(schema.workoutSession.endedAt)))
    .orderBy(desc(schema.workoutSession.endedAt))
    .get();
  if (!row?.endedAt) return null;
  const ts = Date.parse(row.endedAt);
  if (!Number.isFinite(ts)) return null;
  const hoursSince = (now - ts) / 3_600_000;
  if (hoursSince < 0 || hoursSince > hours) return null;
  return { session: row, hoursSince };
}

export function settingsMap(db: Db): Record<string, string> {
  const rows = db.select().from(schema.appSetting).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function remindersEnabled(db: Db): boolean {
  return settingsMap(db).workout_reminder_on !== "false";
}

export function reminderTime(db: Db): string {
  return settingsMap(db).reminder_time ?? "22:30";
}

/** 首页/接口的"今天"总装（GET /api/v1/today 的数据源） */
export function todayFacts(db: Db, today: DateStr): TodayFacts {
  const state = loadScheduleState(db, today);
  const slot = slotOf(today, state.ctx, state.slots);
  const holiday = state.holidays.find((h) => h.date === today) ?? null;
  const sessions = sessionsOn(db, today);
  const session = sessions.find((s) => s.status === "done") ?? sessions[0] ?? null;
  const liveSession = sessions.find((s) => s.status === "doing") ?? null;
  const workoutCheckinRow = db
    .select()
    .from(schema.checkin)
    .where(and(eq(schema.checkin.date, today), eq(schema.checkin.kind, "workout")))
    .get();

  const otRows = overtimesOn(db, today);
  const earliest = earliestOvertime(otRows.map((o) => ({ ...o, start: o.startTime })));

  const cheat = db.select().from(schema.cheatSetting).orderBy(desc(schema.cheatSetting.id)).get();
  // 锚点必须是「真的吃了」的那天（3.4）：一次都没记过时 daysSince 给 null，
  // 首页显示「还没有记录」而不是按安装日锚点算出一个假的「距上次 0 天」（issue #1 第 3 项）
  const hasCheatRecord = !!db
    .select({ id: schema.cheatLog.id })
    .from(schema.cheatLog)
    .limit(1)
    .get();
  const cheatNextDate = cheat
    ? cheatNext({
        anchorDate: cheat.anchorDate,
        intervalDays: cheat.intervalDays,
        today,
        isHoliday: (d) => state.holidaySet.has(d),
        isMakeupWorkday: (d) => state.makeupSet.has(d),
        isTrainingDay: (d) => isTrainingDay(d, state.ctx, state.slots),
      })
    : today;

  return {
    date: today,
    weekday: formatCn(today).split(" ").at(-1) ?? "",
    formatted: formatCn(today),
    holiday,
    slot: slot ?? null,
    slotIndex: slotIndexAt(today, state.ctx),
    isRestDay: !!slot?.rest,
    isTrainingDay: isTrainingDay(today, state.ctx, state.slots),
    skipped: state.skipSet.has(today),
    debt: { owed: [] }, // 由调用方用 debt.owedParts 填充（需要纯函数 + 记录日期）
    session,
    liveSession,
    workoutCheckin: !!workoutCheckinRow,
    overtime: otRows.map((o) => ({
      id: o.id,
      start: o.startTime,
      note: o.note,
      verdict: overtimeVerdict(o.startTime),
    })),
    overtimeEarliest: earliest ? { start: earliest.start, verdict: overtimeVerdict(earliest.start) } : null,
    cheat: {
      daysSince: cheat && hasCheatRecord ? cheatDaysSince(cheat.anchorDate, today) : null,
      nextDate: cheatNextDate,
      intervalDays: cheat?.intervalDays ?? 8,
    },
    suppressedUntil: null,
  };
}

export function countSetsInSessions(db: Db, sessionIds: number[]) {
  if (sessionIds.length === 0) return new Map<number, number>();
  const rows = db
    .select({ sessionId: schema.setLog.sessionId, n: sql<number>`count(*)` })
    .from(schema.setLog)
    .where(inArray(schema.setLog.sessionId, sessionIds))
    .groupBy(schema.setLog.sessionId)
    .all();
  return new Map(rows.map((r) => [r.sessionId, Number(r.n)]));
}

export interface HistoryRow {
  kind: "session" | "checkin" | "cardio";
  date: DateStr;
  id: number;
  part: string;
  mode: "gym" | "home";
  status: "planned" | "doing" | "done" | "aborted";
  sets: number;
  summary: { totalSets?: number; volumeKg?: number } | null;
  partOfDay: string | null;
  /** 有氧行：分钟数（FR-51；与训练记录分开列，不算出勤/容量/streak） */
  cardioMinutes: number | null;
  /** 加练（13.17）：非训练日真练了的那一场，记录页带「加练」标记 */
  isExtra: boolean;
}

/** 历史列表（13.4：打卡与明细分开显示；v1.16 起有氧单独一行） */
export function historyRows(
  db: Db,
  opts: { from?: DateStr; to?: DateStr; limit?: number } = {},
): HistoryRow[] {
  const limit = opts.limit ?? 60;
  const conditions = [];
  if (opts.from) conditions.push(gte(schema.workoutSession.date, opts.from));
  if (opts.to) conditions.push(lte(schema.workoutSession.date, opts.to));

  const sessions = db
    .select()
    .from(schema.workoutSession)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.workoutSession.date), desc(schema.workoutSession.id))
    .limit(limit)
    .all();

  const setCounts = countSetsInSessions(db, sessions.map((s) => s.id));
  const checkins = db
    .select()
    .from(schema.checkin)
    .where(eq(schema.checkin.kind, "workout"))
    .all();
  const checkinDates = new Set(checkins.map((c) => c.date));
  const sessionDates = new Set(sessions.map((s) => s.date));

  const rows: HistoryRow[] = sessions.map((s) => ({
    kind: "session",
    date: s.date,
    id: s.id,
    part: s.part,
    mode: s.mode,
    status: s.status,
    sets: setCounts.get(s.id) ?? 0,
    summary: s.summary as { totalSets?: number; volumeKg?: number } | null,
    partOfDay: s.startedAt ? timeInTz(new Date(s.startedAt)) : null,
    cardioMinutes: null,
    isExtra: s.isExtra,
  }));

  // 「已打卡 · 无明细」的日子（打卡算出勤，明细留空不算偷懒，13.4）
  for (const date of checkinDates) {
    if (sessionDates.has(date)) continue;
    rows.push({
      kind: "checkin",
      date,
      id: 0,
      part: "",
      mode: "gym",
      status: "done",
      sets: 0,
      summary: null,
      partOfDay: null,
      cardioMinutes: null,
      isExtra: false,
    });
  }

  // 有氧（FR-51）：**单独一行**，与训练记录分开；只记分钟数、不算出勤也不进容量
  for (const row of cardioList(db, { from: opts.from, to: opts.to })) {
    rows.push({
      kind: "cardio",
      date: row.date,
      id: row.id,
      part: "",
      mode: "gym",
      status: "done",
      sets: 0,
      summary: null,
      partOfDay: null,
      cardioMinutes: row.minutes,
      isExtra: false,
    });
  }

  rows.sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  return rows.slice(0, limit);
}

export function sessionDetail(db: Db, sessionId: number) {
  const session = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  if (!session) return null;
  const sets = db
    .select({
      id: schema.setLog.id,
      exerciseId: schema.setLog.exerciseId,
      exerciseName: schema.exercise.name,
      exerciseType: schema.exercise.type,
      muscles: schema.exercise.muscles,
      loadMode: schema.exercise.loadMode,
      barKg: schema.exercise.barKg,
      variantId: schema.setLog.variantId,
      variantCode: schema.exerciseVariant.code,
      variantEquip: schema.exerciseVariant.equip,
      variantLabel: schema.exerciseVariant.label,
      variantSemantics: schema.exerciseVariant.loadSemantics,
      setNo: schema.setLog.setNo,
      weightKg: schema.setLog.weightKg,
      reps: schema.setLog.reps,
      durationSec: schema.setLog.durationSec,
      totalLoadKg: schema.setLog.totalLoadKg,
      restBeforeSec: schema.setLog.restBeforeSec,
      sameExercise: schema.setLog.sameExercise,
      doneAt: schema.setLog.doneAt,
      feel: schema.setLog.feel,
      skipped: schema.setLog.skipped,
      isWarmup: schema.setLog.isWarmup,
    })
    .from(schema.setLog)
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    .leftJoin(schema.exerciseVariant, eq(schema.exerciseVariant.id, schema.setLog.variantId))
    .where(eq(schema.setLog.sessionId, sessionId))
    .orderBy(asc(schema.setLog.id))
    .all();

  const sessionExercises = db
    .select({
      id: schema.sessionExercise.id,
      exerciseId: schema.sessionExercise.exerciseId,
      name: schema.exercise.name,
      type: schema.exercise.type,
      equip: schema.exercise.equip,
      muscles: schema.exercise.muscles,
      loadMode: schema.exercise.loadMode,
      barKg: schema.exercise.barKg,
      baseWeight: schema.exercise.baseWeight,
      restSec: schema.exercise.restSec,
      orderNo: schema.sessionExercise.orderNo,
      targetSets: schema.sessionExercise.targetSets,
      targetReps: schema.sessionExercise.targetReps,
      status: schema.sessionExercise.status,
    })
    .from(schema.sessionExercise)
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.sessionExercise.exerciseId))
    .where(eq(schema.sessionExercise.sessionId, sessionId))
    .orderBy(asc(schema.sessionExercise.orderNo))
    .all();

  // 训练中换变体（FR-49）：把每个动作的可用变体一起带出来（默认变体 = 动作本身，id = null）
  const variantsByExercise = new Map<number, VariantView[]>();
  for (const ex of sessionExercises) {
    if (variantsByExercise.has(ex.exerciseId)) continue;
    variantsByExercise.set(ex.exerciseId, variantsOf(db, ex.exerciseId));
  }

  return {
    session,
    sets,
    sessionExercises: sessionExercises.map((ex) => ({
      ...ex,
      variants: variantsByExercise.get(ex.exerciseId) ?? [],
    })),
  };
}

/** 某动作的额外器械变体（默认变体不在这张表里，键 = 动作本身，13.14） */
export function variantsOf(db: Db, exerciseId: number): VariantView[] {
  const exercise = db
    .select()
    .from(schema.exercise)
    .where(eq(schema.exercise.id, exerciseId))
    .get();
  const rows = db
    .select()
    .from(schema.exerciseVariant)
    .where(eq(schema.exerciseVariant.exerciseId, exerciseId))
    .orderBy(asc(schema.exerciseVariant.orderNo))
    .all();
  return [
    {
      id: null,
      code: null,
      equip: exercise?.equip ?? "",
      semantics: "direct",
      label: "",
      baseWeight: exercise?.baseWeight ?? null,
      // 默认变体 = 动作本身，没有变体行可挂读数单位 → 恒跟随全局（要按磅读就加一台变体）
      readUnit: null,
    },
    ...rows.map((v) => ({
      id: v.id,
      code: v.code,
      equip: v.equip,
      semantics: v.loadSemantics,
      label: v.label,
      baseWeight: v.baseWeight,
      readUnit: v.readUnit ?? null,
    })),
  ];
}

/**
 * 完成度的输入行（issue #45 / v1.47）：本场会话每个动作的「目标组数 / 已记正式组数 / 是否记过组」。
 * 分母只算**记过组的动作**（`hasSets`），这样老数据里 0 组的僵尸行不会把完成度拉低。
 */
export function sessionCompletionRows(
  db: Db,
  sessionId: number,
): { exerciseId: number; targetSets: number; doneSets: number; hasSets: boolean }[] {
  const rows = db
    .select({
      exerciseId: schema.sessionExercise.exerciseId,
      targetSets: schema.sessionExercise.targetSets,
    })
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, sessionId))
    .orderBy(asc(schema.sessionExercise.orderNo))
    .all();
  const counted = db
    .select({
      exerciseId: schema.setLog.exerciseId,
      n: sql<number>`count(*)`,
    })
    .from(schema.setLog)
    .where(
      and(
        eq(schema.setLog.sessionId, sessionId),
        eq(schema.setLog.skipped, false),
        eq(schema.setLog.isWarmup, false), // 热身行不算训练量（13.16）
      ),
    )
    .groupBy(schema.setLog.exerciseId)
    .all();
  const byExercise = new Map(counted.map((c) => [c.exerciseId, Number(c.n)]));
  return rows.map((r) => {
    const done = byExercise.get(r.exerciseId) ?? 0;
    return { exerciseId: r.exerciseId, targetSets: r.targetSets, doneSets: done, hasSets: done > 0 };
  });
}
