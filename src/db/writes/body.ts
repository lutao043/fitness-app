/**
 * 幂等写入口 · body（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";

/* ———————————————————————— 身体数据（13.2） ———————————————————————— */

export type BodySlot = "morning" | "bedtime" | "other";

/**
 * 删掉某天某时点这一条（issue #10 附带一问）：记错日期 / 称重失败的记录只能删掉，不能只靠覆盖。
 * 没有这条 = 返回 false（幂等，与 `DELETE /api/v1/skip/{date}` 同惯例）。
 * 删除只删这一条 `(date, slot)`；曲线与目标进度按剩余序列重算（口径 13.2）。
 */
export function deleteBodyMetric(db: Db, input: { date: DateStr; slot: BodySlot }): boolean {
  const res = db
    .delete(schema.bodyMetric)
    .where(and(eq(schema.bodyMetric.date, input.date), eq(schema.bodyMetric.slot, input.slot)))
    .run();
  return res.changes > 0;
}

/** 同一 (date, slot) 一天一条，重复保存 = 覆盖 */
export function upsertBodyMetric(
  db: Db,
  input: {
    date: DateStr;
    slot?: BodySlot;
    weightKg: number;
    bodyFatPct?: number | null;
    note?: string | null;
  },
): { id: number; created: boolean } {
  const slot = input.slot ?? "morning";
  const existing = db
    .select({ id: schema.bodyMetric.id })
    .from(schema.bodyMetric)
    .where(and(eq(schema.bodyMetric.date, input.date), eq(schema.bodyMetric.slot, slot)))
    .get();

  if (existing) {
    db.update(schema.bodyMetric)
      .set({ weightKg: input.weightKg, bodyFatPct: input.bodyFatPct ?? null, note: input.note ?? null })
      .where(eq(schema.bodyMetric.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }
  const inserted = db
    .insert(schema.bodyMetric)
    .values({
      date: input.date,
      slot,
      weightKg: input.weightKg,
      bodyFatPct: input.bodyFatPct ?? null,
      note: input.note ?? null,
    })
    .returning({ id: schema.bodyMetric.id })
    .get();
  return { id: inserted.id, created: true };
}

/**
 * 每日体重分析（FR-57，v1.29）：**按 `date` 覆盖**（同一天重复写 = 更新那一条，幂等）——
 * 写入方只有助手（`source` 固定 assistant），App 只读展示。
 * `created_at` 保留第一次写入的时间，`updated_at` 每次重写都刷新。
 */
export function upsertBodyAnalysis(
  db: Db,
  input: { date: DateStr; level: "normal" | "watch" | "suspect"; text: string },
): { date: DateStr; created: boolean } {
  const nowIso = new Date().toISOString();
  const existing = db
    .select({ date: schema.bodyAnalysis.date })
    .from(schema.bodyAnalysis)
    .where(eq(schema.bodyAnalysis.date, input.date))
    .get();

  if (existing) {
    db.update(schema.bodyAnalysis)
      .set({ level: input.level, text: input.text, updatedAt: nowIso })
      .where(eq(schema.bodyAnalysis.date, input.date))
      .run();
    return { date: input.date, created: false };
  }
  db.insert(schema.bodyAnalysis)
    .values({
      date: input.date,
      level: input.level,
      text: input.text,
      source: "assistant",
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .run();
  return { date: input.date, created: true };
}

/* ———————————————————————— 围度（FR-15，第 6 章 measurement 表） ———————————————————————— */

/** 同日一条（date 唯一）；重复保存按**合并**覆盖 —— 只更新带来的项，未提供的保留原值（补录一项不抹掉别的）；至少一项有值才落库 */
export function upsertMeasurement(
  db: Db,
  input: {
    date: DateStr;
    waistCm?: number | null;
    chestCm?: number | null;
    armCm?: number | null;
    thighCm?: number | null;
  },
): { id: number; created: boolean } {
  const values = {
    waistCm: input.waistCm ?? null,
    chestCm: input.chestCm ?? null,
    armCm: input.armCm ?? null,
    thighCm: input.thighCm ?? null,
  };
  const existing = db
    .select({ id: schema.measurement.id })
    .from(schema.measurement)
    .where(eq(schema.measurement.date, input.date))
    .get();
  if (existing) {
    const patch: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) patch[key] = value;
    }
    if (Object.keys(patch).length > 0) {
      db.update(schema.measurement).set(patch).where(eq(schema.measurement.id, existing.id)).run();
    }
    return { id: existing.id, created: false };
  }
  const inserted = db
    .insert(schema.measurement)
    .values({ date: input.date, ...values })
    .returning({ id: schema.measurement.id })
    .get();
  return { id: inserted.id, created: true };
}
