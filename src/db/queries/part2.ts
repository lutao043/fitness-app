/**
 * 读查询 · part2（issue #26 从 `db/queries.ts` 拆出；语义与拆分前逐字一致）。
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";
import { addDays } from "@/lib/time";
import { slotOf } from "@/lib/schedule";
import { recoveryState } from "@/lib/caliber/recovery";
import type { RecoveryKey } from "@/lib/caliber/recovery";
import { muscleGroups } from "@/lib/caliber/muscles";
import type { ScheduleState, SetHistoryMap, SlotView } from "./part1";

export function latestSetByExerciseVariant(db: Db): SetHistoryMap {
  const rows = db
    .select({
      exerciseId: schema.setLog.exerciseId,
      variantId: schema.setLog.variantId,
      setNo: schema.setLog.setNo,
      weightKg: schema.setLog.weightKg,
      reps: schema.setLog.reps,
      durationSec: schema.setLog.durationSec,
      totalLoadKg: schema.setLog.totalLoadKg,
      restBeforeSec: schema.setLog.restBeforeSec,
      sameExercise: schema.setLog.sameExercise,
      doneAt: schema.setLog.doneAt,
      feel: schema.setLog.feel,
      exerciseName: schema.exercise.name,
    })
    .from(schema.setLog)
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    // 老数据里的热身行不参与「照上次填」（13.16；v1.26 起不再记录热身组）：40kg 的准备组不该变成下次的预填值
    .where(eq(schema.setLog.isWarmup, false))
    .orderBy(desc(schema.setLog.doneAt))
    .all();

  // 已按 done_at 倒序：每个 (动作, 变体) 键保留第一条 = 最近一次
  const map: SetHistoryMap = new Map();
  for (const r of rows) {
    const key = r.variantId === null ? "default" : String(r.variantId);
    let byVariant = map.get(r.exerciseId);
    if (!byVariant) {
      byVariant = new Map();
      map.set(r.exerciseId, byVariant);
    }
    if (byVariant.has(key)) continue;
    byVariant.set(key, {
      exerciseId: r.exerciseId,
      exerciseName: r.exerciseName,
      variantId: r.variantId,
      setNo: r.setNo,
      weightKg: r.weightKg,
      reps: r.reps,
      durationSec: r.durationSec,
      totalLoadKg: r.totalLoadKg,
      restBeforeSec: r.restBeforeSec,
      sameExercise: r.sameExercise,
      doneAt: r.doneAt,
      feel: r.feel,
    });
  }
  return map;
}

/** 最近一次训练里，某部位（大部位）的 ended_at —— 恢复度起点（13.9） */
export function lastEndedAtByGroup(db: Db): Map<string, number> {
  const rows = db
    .select({
      endedAt: schema.workoutSession.endedAt,
      startedAt: schema.workoutSession.startedAt,
      muscles: schema.exercise.muscles,
    })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.workoutSession.id, schema.setLog.sessionId))
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    .where(isNotNull(schema.workoutSession.endedAt))
    .all();

  const out = new Map<string, number>();
  for (const r of rows) {
    const ts = Date.parse(r.endedAt ?? r.startedAt ?? "");
    if (!Number.isFinite(ts)) continue;
    for (const g of muscleGroups(r.muscles)) {
      const prev = out.get(g);
      if (prev === undefined || ts > prev) out.set(g, ts);
    }
  }
  return out;
}

export interface RecoveryRow {
  group: string;
  key: RecoveryKey;
  label: string;
  hoursSince: number | null;
  pct: number;
  /** 距下次轮到 X 天（13.9 的两段并列展示） */
  nextDays: number | null;
}

export function recoveryRows(
  db: Db,
  state: ScheduleState,
  today: DateStr,
  now: number,
): RecoveryRow[] {
  const lastByGroup = lastEndedAtByGroup(db);
  const groups = new Set<string>();
  for (const slot of state.slots) {
    for (const g of muscleGroups(slot.muscles ?? [])) groups.add(g);
  }
  for (const g of lastByGroup.keys()) groups.add(g);

  const rows: RecoveryRow[] = [];
  for (const group of groups) {
    const endedAt = lastByGroup.get(group) ?? null;
    const r = recoveryState(endedAt, now, state.ctx.cycleLen);
    // 距下次轮到：往前找 120 天内第一个覆盖该大部位、且占位的训练日
    let nextDays: number | null = null;
    for (let i = 0; i < 120; i++) {
      const d = addDays(today, i);
      if (state.holidaySet.has(d) || state.skipSet.has(d)) continue;
      const slot = slotOf(d, state.ctx, state.slots);
      if (!slot || slot.rest) continue;
      if (muscleGroups(slot.muscles ?? []).includes(group as never)) {
        nextDays = i;
        break;
      }
    }
    rows.push({
      group,
      key: r.key,
      label: r.label,
      hoursSince: r.hoursSince,
      pct: r.pct,
      nextDays,
    });
  }
  return rows;
}

export interface TodayFacts {
  date: DateStr;
  weekday: string;
  formatted: string;
  holiday: { name: string; type: "holiday" | "workday" } | null;
  slot: SlotView | null;
  slotIndex: number;
  isRestDay: boolean;
  isTrainingDay: boolean;
  skipped: boolean;
  debt: { owed: { date: DateStr; part: string }[] };
  session: SessionSummaryRow | null;
  liveSession: SessionSummaryRow | null;
  workoutCheckin: boolean;
  overtime: { id: number; start: string; note: string | null; verdict: "ok" | "late" }[];
  overtimeEarliest: { start: string; verdict: "ok" | "late" } | null;
  cheat: { /** 从没记过放纵餐时为 null（显示「还没有记录」，不显示假的 0 天）—— 3.4 / issue #1 第 3 项 */
    daysSince: number | null;
    nextDate: DateStr;
    intervalDays: number;
  };
  suppressedUntil: string | null;
}

export interface SessionSummaryRow {
  id: number;
  clientId: string;
  date: DateStr;
  part: string;
  mode: "gym" | "home";
  status: "planned" | "doing" | "done" | "aborted";
  startedAt: string | null;
  endedAt: string | null;
  summary: unknown;
  /** 加练（13.17）：非训练日真练了的那一场 */
  isExtra: boolean;
}

export function sessionsOn(db: Db, date: DateStr): SessionSummaryRow[] {
  return db
    .select({
      id: schema.workoutSession.id,
      clientId: schema.workoutSession.clientId,
      date: schema.workoutSession.date,
      part: schema.workoutSession.part,
      mode: schema.workoutSession.mode,
      status: schema.workoutSession.status,
      startedAt: schema.workoutSession.startedAt,
      endedAt: schema.workoutSession.endedAt,
      summary: schema.workoutSession.summary,
      isExtra: schema.workoutSession.isExtra,
    })
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.date, date))
    .orderBy(desc(schema.workoutSession.id))
    .all();
}

/** 当天"算练了"的会话：status ∈ {doing, done}（13.3 / 13.10 第 1 条） */
export function recordedSessionOn(db: Db, date: DateStr): SessionSummaryRow | null {
  const rows = sessionsOn(db, date).filter((s) => s.status === "doing" || s.status === "done");
  return rows.find((s) => s.status === "doing") ?? rows[0] ?? null;
}

/**
 * 最后一次「训练 / workout 打卡」的日子（13.8）：欠账回溯（`owedParts`）的停止线。
 * **顺延不算** —— 顺延日本身就是欠账，把它算进来回溯会立刻中断、欠账恒为空。
 */
export function lastRecordDate(db: Db): DateStr | null {
  const candidates: DateStr[] = [];
  const lastSession = db
    .select({ date: schema.workoutSession.date })
    .from(schema.workoutSession)
    .where(inArray(schema.workoutSession.status, ["doing", "done"]))
    .orderBy(desc(schema.workoutSession.date))
    .get();
  if (lastSession) candidates.push(lastSession.date);
  const lastCheckin = db
    .select({ date: schema.checkin.date })
    .from(schema.checkin)
    .where(eq(schema.checkin.kind, "workout"))
    .orderBy(desc(schema.checkin.date))
    .get();
  if (lastCheckin) candidates.push(lastCheckin.date);
  if (candidates.length === 0) return null;
  return candidates.sort().at(-1) ?? null;
}

/**
 * 最后一次「有动作」的日子（停练计数用，FR-38 / pause.ts）：顺延也算 ——
 * 否则连续顺延会被当成停练、天天问重锚。欠账回溯请用 `lastRecordDate`。
 */
export function lastActivityDate(db: Db, today: DateStr): DateStr | null {
  const byRecord = lastRecordDate(db);
  const lastSkip = db
    .select({ date: schema.skipDay.date })
    .from(schema.skipDay)
    .where(lte(schema.skipDay.date, today))
    .orderBy(desc(schema.skipDay.date))
    .get();
  if (!lastSkip) return byRecord;
  return byRecord !== null && byRecord > lastSkip.date ? byRecord : lastSkip.date;
}

/**
 * 有记录的日期集合（streak 用，13.6）：
 * 体重 ∪ 训练（doing/done）∪ **workout 打卡** —— 补剂打卡不参与。
 */
export function recordedDates(db: Db): Set<DateStr> {
  const out = new Set<DateStr>();
  for (const r of db.select({ date: schema.bodyMetric.date }).from(schema.bodyMetric).all()) out.add(r.date);
  for (const r of db
    .select({ date: schema.workoutSession.date })
    .from(schema.workoutSession)
    .where(inArray(schema.workoutSession.status, ["doing", "done"]))
    .all()) {
    out.add(r.date);
  }
  for (const r of db
    .select({ date: schema.checkin.date })
    .from(schema.checkin)
    .where(eq(schema.checkin.kind, "workout"))
    .all()) {
    out.add(r.date);
  }
  return out;
}

export function overtimesOn(db: Db, date: DateStr) {
  return db.select().from(schema.overtime).where(eq(schema.overtime.date, date)).all();
}

/** 加班全量（我的页维护用，倒序） */
export function overtimesAll(db: Db, limit = 30) {
  return db
    .select()
    .from(schema.overtime)
    .orderBy(desc(schema.overtime.date), desc(schema.overtime.id))
    .limit(limit)
    .all();
}

/**
 * 出勤日期集合（13.4，记录页统计卡）：训练会话（doing/done）∪ workout 打卡 ——
 * **不含体重**（那是 streak 的口径，13.6）；打卡算出勤，不等于有明细。
 */
export function attendanceDates(db: Db): Set<DateStr> {
  const out = new Set<DateStr>();
  for (const r of db
    .select({ date: schema.workoutSession.date })
    .from(schema.workoutSession)
    .where(inArray(schema.workoutSession.status, ["doing", "done"]))
    .all()) {
    out.add(r.date);
  }
  for (const r of db
    .select({ date: schema.checkin.date })
    .from(schema.checkin)
    .where(eq(schema.checkin.kind, "workout"))
    .all()) {
    out.add(r.date);
  }
  return out;
}

/**
 * 提醒事件是否已存在（FR-37 的去重查询）。
 * 带 `date` = 当天是否生成过（事件键 type+ref_key+date）；不带 = 这个引用键是否生成过任何事件
 * （重锚建议一个建议只发一次问，用后者）。
 */
export function reminderEventExists(
  db: Db,
  type: "workout" | "supplement" | "cheat" | "reanchor" | "holiday_gap",
  refKey: string,
  date?: DateStr,
): boolean {
  const conds = [eq(schema.reminderEvent.type, type), eq(schema.reminderEvent.refKey, refKey)];
  if (date) conds.push(eq(schema.reminderEvent.date, date));
  return db.select({ id: schema.reminderEvent.id }).from(schema.reminderEvent).where(and(...conds)).get() !== undefined;
}

export function supplementsFor(db: Db, date: DateStr) {
  const list = db
    .select()
    .from(schema.supplement)
    .where(eq(schema.supplement.enabled, true))
    .orderBy(asc(schema.supplement.orderNo))
    .all();
  const taken = new Set(
    db
      .select({ refId: schema.checkin.refId })
      .from(schema.checkin)
      .where(and(eq(schema.checkin.date, date), eq(schema.checkin.kind, "supplement")))
      .all()
      .map((r) => r.refId),
  );
  return list.map((s) => ({ ...s, takenToday: taken.has(String(s.id)) }));
}

/** 补剂清单全量（含已停用的，FR-33 的维护界面用） */
export function supplementsAll(db: Db) {
  return db.select().from(schema.supplement).orderBy(asc(schema.supplement.orderNo)).all();
}

/** 放纵餐设置（FR-25）：间隔 + 锚点 + 最近一次真的吃了的那天 */
export function cheatSettingView(db: Db) {
  const setting = db.select().from(schema.cheatSetting).orderBy(desc(schema.cheatSetting.id)).get() ?? null;
  const lastLog = db.select().from(schema.cheatLog).orderBy(desc(schema.cheatLog.date), desc(schema.cheatLog.id)).get();
  return {
    intervalDays: setting?.intervalDays ?? 8,
    anchorDate: setting?.anchorDate ?? null,
    lastLogDate: lastLog?.date ?? null,
    logCount: db.select({ id: schema.cheatLog.id }).from(schema.cheatLog).all().length,
  };
}

/* ————————————— 有氧（FR-50 / v1.16） ————————————— */

/** 某天的有氧记录（没有就 null）；一天一条（覆盖语义） */
export function cardioOn(db: Db, date: DateStr) {
  return db.select().from(schema.cardioLog).where(eq(schema.cardioLog.date, date)).get() ?? null;
}

/** 有氧序列（升序；今日页的"近 7 天合计"与记录页共用） */
export function cardioList(db: Db, opts: { from?: DateStr; to?: DateStr; limit?: number } = {}) {
  const conditions = [];
  if (opts.from) conditions.push(gte(schema.cardioLog.date, opts.from));
  if (opts.to) conditions.push(lte(schema.cardioLog.date, opts.to));
  return db
    .select()
    .from(schema.cardioLog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.cardioLog.date))
    .limit(opts.limit ?? 180)
    .all()
    .reverse();
}
