/**
 * 幂等写入口 · cardio（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";

/* ———————————————————————— 有氧（FR-50 / v1.16） ———————————————————————— */

/** 记 / 改某天的有氧：一天一条，重复保存 = 覆盖（幂等，与体重同一套语义） */
export function upsertCardioLog(
  db: Db,
  input: { date: DateStr; minutes: number; note?: string | null },
): { id: number; created: boolean } {
  const existing = db
    .select({ id: schema.cardioLog.id })
    .from(schema.cardioLog)
    .where(eq(schema.cardioLog.date, input.date))
    .get();
  if (existing) {
    db.update(schema.cardioLog)
      .set({ minutes: input.minutes, note: input.note ?? null })
      .where(eq(schema.cardioLog.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  }
  const inserted = db
    .insert(schema.cardioLog)
    .values({ date: input.date, minutes: input.minutes, note: input.note ?? null })
    .returning({ id: schema.cardioLog.id })
    .get();
  return { id: inserted.id, created: true };
}

export function deleteCardioLog(db: Db, date: DateStr): { removed: boolean } {
  const res = db.delete(schema.cardioLog).where(eq(schema.cardioLog.date, date)).run();
  return { removed: res.changes > 0 };
}
