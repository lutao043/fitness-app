/**
 * 幂等写入口 · checkin（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { loadScheduleState } from "@/db/queries";
import type { DateStr } from "@/lib/time";
import { extraTrainingPoints, isTrainingDay } from "@/lib/schedule";

/* ———————————————————————— 打卡（13.4） ———————————————————————— */

/**
 * 撤掉一条**由系统派生**的打卡（issue #15 / v1.33）：只删 `(date, kind, ref_id)` 精确匹配的那条 ——
 * 会话置 done 时自动写的那条带 `ref_id = 会话 id`，所以"会话置 aborted / 删除"能**精确撤自己的**，
 * 不会误伤用户手点的「一键打卡」（它 `ref_id` 为空）或另一场会话的打卡。
 * 没有这条也返回 `removed:false`（幂等，与 `DELETE /api/v1/skip/{date}` 同惯例）。
 */
export function revokeCheckin(
  db: Db,
  input: { date: DateStr; kind: "workout" | "supplement"; refId: string | number },
): { removed: boolean } {
  const res = db
    .delete(schema.checkin)
    .where(
      and(
        eq(schema.checkin.date, input.date),
        eq(schema.checkin.kind, input.kind),
        eq(schema.checkin.refId, String(input.refId)),
      ),
    )
    .run();
  return { removed: res.changes > 0 };
}

/** 按 (date, kind, ref_id) 去重：重复打卡 = no-op（返回既有的） */
export function ensureCheckin(
  db: Db,
  input: {
    date: DateStr;
    kind: "workout" | "supplement";
    refId?: string | number | null;
    source: "web" | "assistant" | "reminder";
  },
): { id: number; created: boolean } {
  const refId = input.refId === null || input.refId === undefined ? "" : String(input.refId);
  const existing = db
    .select({ id: schema.checkin.id })
    .from(schema.checkin)
    .where(
      and(
        eq(schema.checkin.date, input.date),
        eq(schema.checkin.kind, input.kind),
        eq(schema.checkin.refId, refId),
      ),
    )
    .get();
  if (existing) return { id: existing.id, created: false };
  const inserted = db
    .insert(schema.checkin)
    .values({ date: input.date, kind: input.kind, refId, source: input.source })
    .returning({ id: schema.checkin.id })
    .get();
  return { id: inserted.id, created: true };
}

/* ———————————————————————— 顺延（13.8） ———————————————————————— */

export function ensureSkip(
  db: Db,
  input: { date: DateStr; reason: "missed" | "overtime" | "holiday" | "manual"; note?: string | null },
): { id: number; created: boolean } {
  const existing = db
    .select({ id: schema.skipDay.id })
    .from(schema.skipDay)
    .where(eq(schema.skipDay.date, input.date))
    .get();
  if (existing) return { id: existing.id, created: false }; // 同日只此一条，重复调用 = no-op
  const inserted = db
    .insert(schema.skipDay)
    .values({ date: input.date, reason: input.reason, note: input.note ?? null })
    .returning({ id: schema.skipDay.id })
    .get();
  return { id: inserted.id, created: true };
}

/** 撤销顺延（13.8 的 5 秒撤销走它）：删掉该日 skip_day，排期回原样 */
export function removeSkip(db: Db, date: DateStr): { removed: boolean } {
  const res = db.delete(schema.skipDay).where(eq(schema.skipDay.date, date)).run();
  return { removed: res.changes > 0 };
}

/* ———————————————————————— 加练（13.17） ———————————————————————— */

/**
 * 加练的循环位点落库（13.17）：
 * ① 今天没休的「休」顺延到明天；② 加练部位的下一次排期换成它的下一位（后面的日子顺次前移）。
 *
 * 幂等：位点带 `ref_session_id`，同一个会话只写一次（重复调用 no-op —— 第 7 章"写接口可安全重试"）。
 * 只在**非训练日**生效；训练日不是加练（FR-4 的「改练其他部位」一个位点都不写）。
 */
export function applyExtraTrainingShift(
  db: Db,
  input: { sessionId: number; date: DateStr; templateId: number | null },
): { applied: boolean; points: { date: DateStr; position: number }[] } {
  const existing = db
    .select({ id: schema.cyclePoint.id })
    .from(schema.cyclePoint)
    .where(eq(schema.cyclePoint.refSessionId, input.sessionId))
    .limit(1)
    .get();
  if (existing) return { applied: false, points: [] };

  const state = loadScheduleState(db, input.date);
  const slotIndex = state.slots.findIndex((s) => s.templateId === input.templateId);
  const slot = slotIndex >= 0 ? state.slots[slotIndex] : null;
  if (!slot || slot.rest) return { applied: false, points: [] };
  if (isTrainingDay(input.date, state.ctx, state.slots)) return { applied: false, points: [] };

  const points = extraTrainingPoints({
    date: input.date,
    slotPosition: slotIndex,
    slots: state.slots,
    ctx: state.ctx,
  });
  if (points.length > 0) {
    db.transaction((tx) => {
      for (const p of points) {
        tx.insert(schema.cyclePoint)
          .values({
            schemeId: state.schemeId,
            date: p.date,
            position: p.position,
            reason: "extra",
            refSessionId: input.sessionId,
            note: `${input.date} 加练「${slot.label}」`,
          })
          .run();
      }
    });
  }
  return { applied: true, points };
}

/** 撤加练的位点（会话被删 / 被置 aborted 时用，13.17）：排期回原样。 */
export function revertExtraTrainingShift(db: Db, sessionId: number): { removed: number } {
  const res = db.delete(schema.cyclePoint).where(eq(schema.cyclePoint.refSessionId, sessionId)).run();
  return { removed: res.changes };
}
