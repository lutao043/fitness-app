/**
 * 读查询 · part4（issue #26 从 `db/queries.ts` 拆出；语义与拆分前逐字一致）。
 */

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";
import { addDays, dateInTz, dayDiff } from "@/lib/time";
import { muscleGroups } from "@/lib/caliber/muscles";

export function partBreakdown(
  db: Db,
  from: DateStr,
  to: DateStr,
): { group: string; sets: number; volumeKg: number }[] {
  const rows = db
    .select({
      skipped: schema.setLog.skipped,
      isWarmup: schema.setLog.isWarmup,
      totalLoadKg: schema.setLog.totalLoadKg,
      reps: schema.setLog.reps,
      muscles: schema.exercise.muscles,
    })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.workoutSession.id, schema.setLog.sessionId))
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    .where(
      and(
        gte(schema.workoutSession.date, from),
        lte(schema.workoutSession.date, to),
        inArray(schema.workoutSession.status, ["doing", "done"]),
      ),
    )
    .all();

  const byGroup = new Map<string, { sets: number; volumeKg: number }>();
  for (const r of rows) {
    // 热身行不算（13.16）：否则"胸练了 12 组"里会混进 4 组准备组（v1.26 起不再记录，这里管的是老数据）
    if (r.skipped || r.isWarmup) continue;
    const volume = (r.totalLoadKg ?? 0) * (r.reps ?? 0);
    for (const g of muscleGroups(r.muscles ?? [])) {
      const cur = byGroup.get(g) ?? { sets: 0, volumeKg: 0 };
      cur.sets += 1;
      cur.volumeKg += volume;
      byGroup.set(g, cur);
    }
  }
  return [...byGroup.entries()]
    .map(([group, v]) => ({ group, sets: v.sets, volumeKg: Math.round(v.volumeKg) }))
    .sort((a, b) => b.sets - a.sets || a.group.localeCompare(b.group));
}

export interface RecordedVariant {
  exerciseId: number;
  exerciseName: string;
  /** null = 默认变体（动作本身） */
  variantId: number | null;
  variantLabel: string | null;
  sets: number;
  lastDate: DateStr;
}

/** FR-27 的动作选择清单：有记录的「动作 × 变体」，按最近练的在前（13.14：趋势按动作 × 变体） */
export function recordedExerciseVariants(db: Db, limit = 60): RecordedVariant[] {
  const rows = db
    .select({
      exerciseId: schema.setLog.exerciseId,
      exerciseName: schema.exercise.name,
      variantId: schema.setLog.variantId,
      variantCode: schema.exerciseVariant.code,
      variantEquip: schema.exerciseVariant.equip,
      date: schema.workoutSession.date,
    })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.workoutSession.id, schema.setLog.sessionId))
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    .leftJoin(schema.exerciseVariant, eq(schema.exerciseVariant.id, schema.setLog.variantId))
    .where(inArray(schema.workoutSession.status, ["doing", "done"]))
    .all();

  const byKey = new Map<string, RecordedVariant>();
  for (const r of rows) {
    const key = `${r.exerciseId}#${r.variantId ?? "default"}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        exerciseId: r.exerciseId,
        exerciseName: r.exerciseName,
        variantId: r.variantId,
        variantLabel: r.variantId === null ? null : r.variantEquip ?? r.variantCode ?? `变体 #${r.variantId}`,
        sets: 1,
        lastDate: r.date,
      });
      continue;
    }
    cur.sets += 1;
    if (r.date > cur.lastDate) cur.lastDate = r.date;
  }
  return [...byKey.values()]
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : b.sets - a.sets))
    .slice(0, limit);
}

export interface TrendRow {
  date: DateStr;
  /** 该日该动作×变体的最大重量（单侧读数口径，13.1/13.14） */
  maxWeightKg: number | null;
  sets: number;
  volumeKg: number;
}

/** FR-27：单个「动作 × 变体」的重量趋势 —— 每个训练日一个点，取当日最大单侧重量 */
export function exerciseTrend(
  db: Db,
  exerciseId: number,
  variantId: number | null,
  days = 90,
): TrendRow[] {
  const today = dateInTz();
  const from = addDays(today, -(days - 1));
  const conds = [
    gte(schema.workoutSession.date, from),
    lte(schema.workoutSession.date, today),
    inArray(schema.workoutSession.status, ["doing", "done"]),
    eq(schema.setLog.exerciseId, exerciseId),
  ];
  if (variantId === null) conds.push(sql`${schema.setLog.variantId} IS NULL`);
  else conds.push(eq(schema.setLog.variantId, variantId));

  const rows = db
    .select({
      date: schema.workoutSession.date,
      skipped: schema.setLog.skipped,
      isWarmup: schema.setLog.isWarmup,
      weightKg: schema.setLog.weightKg,
      totalLoadKg: schema.setLog.totalLoadKg,
      reps: schema.setLog.reps,
    })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.workoutSession.id, schema.setLog.sessionId))
    .where(and(...conds))
    .all();

  const byDate = new Map<DateStr, TrendRow>();
  for (const r of rows) {
    const cur = byDate.get(r.date) ?? { date: r.date, maxWeightKg: null, sets: 0, volumeKg: 0 };
    // 热身行不进趋势（13.16）：准备组会把"当日峰值"压成热身重量（v1.26 起不再记录，这里管的是老数据）
    if (!r.skipped && !r.isWarmup) {
      cur.sets += 1;
      cur.volumeKg += (r.totalLoadKg ?? 0) * (r.reps ?? 0);
      if (r.weightKg !== null && (cur.maxWeightKg === null || r.weightKg > cur.maxWeightKg)) {
        cur.maxWeightKg = r.weightKg;
      }
    }
    byDate.set(r.date, cur);
  }
  return [...byDate.values()]
    .map((r) => ({ ...r, volumeKg: Math.round(r.volumeKg) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function bodySeries(db: Db, limit = 180) {
  return db
    .select()
    .from(schema.bodyMetric)
    .orderBy(desc(schema.bodyMetric.date))
    .limit(limit)
    .all()
    .reverse();
}

/** 围度序列（FR-15/17，第 6 章 measurement 表：同日一条），升序返回 */
export function measurementsList(db: Db, limit = 180) {
  return db
    .select()
    .from(schema.measurement)
    .orderBy(desc(schema.measurement.date))
    .limit(limit)
    .all()
    .reverse();
}

/**
 * FR-20：最近 N 天各大部位**练了几天**（同一部位同一天多个动作只计 1 天）。
 * 按动作的细分肌群解析到大部位（13.15 展示映射）；无明细的打卡日没法归部位，不计。
 */
export function partFrequency(db: Db, today: DateStr, days = 7): { group: string; days: number }[] {
  const from = addDays(today, -(days - 1));
  const rows = db
    .select({ date: schema.workoutSession.date, muscles: schema.exercise.muscles })
    .from(schema.setLog)
    .innerJoin(schema.workoutSession, eq(schema.workoutSession.id, schema.setLog.sessionId))
    .innerJoin(schema.exercise, eq(schema.exercise.id, schema.setLog.exerciseId))
    .where(
      and(
        gte(schema.workoutSession.date, from),
        lte(schema.workoutSession.date, today),
        inArray(schema.workoutSession.status, ["doing", "done"]),
      ),
    )
    .all();

  const seenByDate = new Map<DateStr, Set<string>>();
  for (const r of rows) {
    let seen = seenByDate.get(r.date);
    if (!seen) {
      seen = new Set<string>();
      seenByDate.set(r.date, seen);
    }
    for (const g of muscleGroups(r.muscles ?? [])) seen.add(g);
  }

  const counts = new Map<string, number>();
  for (const groups of seenByDate.values()) {
    for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, n]) => ({ group, days: n }))
    .sort((a, b) => b.days - a.days || a.group.localeCompare(b.group));
}

export function todayInApp(now: Date = new Date()): DateStr {
  return dateInTz(now);
}

export function daysBetween(a: DateStr, b: DateStr): number {
  return dayDiff(a, b);
}
