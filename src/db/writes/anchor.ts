/**
 * 幂等写入口 · anchor（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr, TimeStr } from "@/lib/time";
import type { ReminderEventType } from "@/lib/reminder/dedup";

/* ———————————————————————— 锚点与重锚（FR-38） ———————————————————————— */

/** 只追加、不修改：方便回溯"为什么今天显示这个部位" */
export function appendAnchor(
  db: Db,
  input: {
    schemeId: string;
    anchorDate: DateStr;
    cyclePosition: number;
    reason: string;
    note?: string | null;
  },
): { id: number } {
  return db
    .insert(schema.scheduleAnchor)
    .values({
      schemeId: input.schemeId,
      anchorDate: input.anchorDate,
      cyclePosition: input.cyclePosition,
      reason: input.reason,
      note: input.note ?? null,
    })
    .returning({ id: schema.scheduleAnchor.id })
    .get();
}

export function activeSchemeId(db: Db): string {
  const row = db
    .select({ id: schema.splitScheme.id })
    .from(schema.splitScheme)
    .where(eq(schema.splitScheme.active, true))
    .get();
  if (!row) throw new Error("没有启用的分化方案");
  return row.id;
}

export function createAnchorProposal(
  db: Db,
  input: { date: DateStr; suggestedPosition: number },
): { id: number } {
  return db
    .insert(schema.anchorProposal)
    .values({ date: input.date, suggestedPosition: input.suggestedPosition, status: "pending" })
    .returning({ id: schema.anchorProposal.id })
    .get();
}

export function decideAnchorProposal(
  db: Db,
  id: number,
  status: "accepted" | "rejected",
  decidedAt = new Date().toISOString(),
): { updated: boolean } {
  const res = db
    .update(schema.anchorProposal)
    .set({ status, decidedAt })
    .where(eq(schema.anchorProposal.id, id))
    .run();
  return { updated: res.changes > 0 };
}

export function pendingAnchorProposal(db: Db) {
  return db
    .select()
    .from(schema.anchorProposal)
    .where(eq(schema.anchorProposal.status, "pending"))
    .orderBy(schema.anchorProposal.id)
    .get();
}

export function lastRejectedProposalDate(db: Db): DateStr | null {
  const row = db
    .select({ decidedAt: schema.anchorProposal.decidedAt, date: schema.anchorProposal.date })
    .from(schema.anchorProposal)
    .where(eq(schema.anchorProposal.status, "rejected"))
    .orderBy(sql`${schema.anchorProposal.id} desc`)
    .get();
  if (!row) return null;
  return (row.decidedAt ?? row.date).slice(0, 10);
}

/* ———————————————————————— 放纵餐（3.4） ———————————————————————— */

/** 记"今天真吃了"→ 自动把锚点挪到今天（FR-25） */
export function recordCheatMeal(db: Db, input: { date: DateStr; note?: string | null }): { id: number } {
  return db.transaction((tx) => {
    const logged = tx
      .insert(schema.cheatLog)
      .values({ date: input.date, note: input.note ?? null })
      .returning({ id: schema.cheatLog.id })
      .get();
    const setting = tx
      .select()
      .from(schema.cheatSetting)
      .orderBy(sql`${schema.cheatSetting.id} desc`)
      .get();
    if (setting) {
      tx.update(schema.cheatSetting)
        .set({ anchorDate: input.date })
        .where(eq(schema.cheatSetting.id, setting.id))
        .run();
    } else {
      tx.insert(schema.cheatSetting).values({ intervalDays: 8, anchorDate: input.date }).run();
    }
    return logged;
  });
}

/* ———————————————————————— 加班（3.3 / FR-22） ———————————————————————— */

export function addOvertime(
  db: Db,
  input: { date: DateStr; start: TimeStr; note?: string | null },
): { id: number } {
  return db
    .insert(schema.overtime)
    .values({ date: input.date, startTime: input.start, note: input.note ?? null })
    .returning({ id: schema.overtime.id })
    .get();
}

export function updateOvertime(
  db: Db,
  id: number,
  patch: { date?: DateStr; start?: TimeStr; note?: string | null },
): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.date !== undefined) values.date = patch.date;
  if (patch.start !== undefined) values.startTime = patch.start;
  if (patch.note !== undefined) values.note = patch.note;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.overtime).set(values).where(eq(schema.overtime.id, id)).run();
  return { updated: res.changes > 0 };
}

export function deleteOvertime(db: Db, id: number): { removed: boolean } {
  const res = db.delete(schema.overtime).where(eq(schema.overtime.id, id)).run();
  return { removed: res.changes > 0 };
}

export function getOvertime(db: Db, id: number) {
  return db.select().from(schema.overtime).where(eq(schema.overtime.id, id)).get() ?? null;
}

/* ———————————————————————— 提醒事件与投递（FR-36/37） ———————————————————————— */

/** 事件按 (type, ref_key, date) 全天只生成一条；重复调用返回既有事件 */
export function ensureReminderEvent(
  db: Db,
  input: { type: ReminderEventType; refKey: string; date: DateStr; payload?: unknown },
): { id: number; created: boolean } {
  const existing = db
    .select({ id: schema.reminderEvent.id })
    .from(schema.reminderEvent)
    .where(
      and(
        eq(schema.reminderEvent.type, input.type),
        eq(schema.reminderEvent.refKey, input.refKey),
        eq(schema.reminderEvent.date, input.date),
      ),
    )
    .get();
  if (existing) return { id: existing.id, created: false };
  const inserted = db
    .insert(schema.reminderEvent)
    .values({
      type: input.type,
      refKey: input.refKey,
      date: input.date,
      payload: input.payload ?? null,
    })
    .returning({ id: schema.reminderEvent.id })
    .get();
  return { id: inserted.id, created: true };
}

/**
 * 投递按渠道各记一次；同一 (事件, 渠道) 重复标记 = no-op（FR-37）。
 * 例外是 **dry_run → sent 的升级**（10.1 切换动作：试运行期投递记 dry_run，
 * 切换后助手真实投递完调 `/sent` 把状态切到 sent）—— 只升不降，sent 不会再变回 dry_run。
 */
export function markDelivery(
  db: Db,
  input: { eventId: number; channel: "feishu" | "pwa"; status?: "sent" | "dry_run" },
): { created: boolean; upgraded: boolean } {
  const existing = db
    .select({ id: schema.reminderDelivery.id, status: schema.reminderDelivery.status })
    .from(schema.reminderDelivery)
    .where(
      and(
        eq(schema.reminderDelivery.eventId, input.eventId),
        eq(schema.reminderDelivery.channel, input.channel),
      ),
    )
    .get();
  if (existing) {
    if (existing.status === "dry_run" && input.status === "sent") {
      db.update(schema.reminderDelivery)
        .set({ status: "sent", sentAt: new Date().toISOString() })
        .where(eq(schema.reminderDelivery.id, existing.id))
        .run();
      return { created: false, upgraded: true };
    }
    return { created: false, upgraded: false };
  }
  db.insert(schema.reminderDelivery)
    .values({ eventId: input.eventId, channel: input.channel, status: input.status ?? "sent" })
    .run();
  return { created: true, upgraded: false };
}
