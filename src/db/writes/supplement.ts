/**
 * 幂等写入口 · supplement（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";
import type { SupplementDayKind } from "@/lib/reminder/date-kind";

/* ———————————————————————— 规则管理：补剂清单（FR-33） ———————————————————————— */

export function supplementById(db: Db, id: number) {
  return db.select().from(schema.supplement).where(eq(schema.supplement.id, id)).get() ?? null;
}

export function createSupplement(
  db: Db,
  input: { name: string; times: string[]; doseText?: string; enabled?: boolean; dayKind?: SupplementDayKind },
): { id: number } {
  const maxOrder = db
    .select({ orderNo: schema.supplement.orderNo })
    .from(schema.supplement)
    .all()
    .reduce((m, r) => Math.max(m, r.orderNo), -1);
  return db
    .insert(schema.supplement)
    .values({
      name: input.name,
      times: input.times,
      doseText: input.doseText ?? "",
      orderNo: maxOrder + 1,
      enabled: input.enabled ?? true,
      dayKind: input.dayKind ?? "daily",
    })
    .returning({ id: schema.supplement.id })
    .get();
}

export function updateSupplement(
  db: Db,
  id: number,
  patch: { name?: string; times?: string[]; doseText?: string; enabled?: boolean; dayKind?: SupplementDayKind },
): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.times !== undefined) values.times = patch.times;
  if (patch.doseText !== undefined) values.doseText = patch.doseText;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.dayKind !== undefined) values.dayKind = patch.dayKind;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.supplement).set(values).where(eq(schema.supplement.id, id)).run();
  return { updated: res.changes > 0 };
}

/**
 * 删补剂：清单里去掉，并清掉**今天及以后**尚未投递的补剂提醒事件
 * （不然助手轮询 due 还会为它推一条；历史事件留着当账）。
 */
export function deleteSupplement(db: Db, id: number, today: DateStr): { removed: boolean } {
  return db.transaction((tx) => {
    tx.delete(schema.supplement).where(eq(schema.supplement.id, id)).run();
    const events = tx
      .select({ id: schema.reminderEvent.id })
      .from(schema.reminderEvent)
      .where(
        and(
          eq(schema.reminderEvent.type, "supplement"),
          eq(schema.reminderEvent.refKey, `supp:${id}`),
          gte(schema.reminderEvent.date, today),
        ),
      )
      .all();
    for (const event of events) {
      tx.delete(schema.reminderDelivery).where(eq(schema.reminderDelivery.eventId, event.id)).run();
      tx.delete(schema.reminderEvent).where(eq(schema.reminderEvent.id, event.id)).run();
    }
    return { removed: true };
  });
}

/** 补剂排序：与相邻一条换位（order_no 不设唯一索引，直接交换即可） */
export function moveSupplement(db: Db, id: number, direction: -1 | 1): { moved: boolean } {
  const row = supplementById(db, id);
  if (!row) return { moved: false };
  const siblings = db.select().from(schema.supplement).orderBy(asc(schema.supplement.orderNo)).all();
  const index = siblings.findIndex((s) => s.id === id);
  const target = siblings[index + direction];
  if (!target) return { moved: false };
  db.transaction((tx) => {
    tx.update(schema.supplement).set({ orderNo: target.orderNo }).where(eq(schema.supplement.id, row.id)).run();
    tx.update(schema.supplement).set({ orderNo: row.orderNo }).where(eq(schema.supplement.id, target.id)).run();
  });
  return { moved: true };
}

/** 放纵餐间隔（FR-25；锚点由「今天真吃了」挪） */
export function setCheatInterval(db: Db, intervalDays: number): void {
  const setting = db.select().from(schema.cheatSetting).orderBy(desc(schema.cheatSetting.id)).get();
  if (setting) {
    db.update(schema.cheatSetting).set({ intervalDays }).where(eq(schema.cheatSetting.id, setting.id)).run();
  }
}
