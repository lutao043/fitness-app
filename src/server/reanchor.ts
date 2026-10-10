/**
 * 重锚相关的服务端小工具（供 /reanchor 与 /reanchor/proposals 共用）。
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { activeSchemeId } from "@/db/writes";

export { activeSchemeId };

/** 方案槽位数（校验 cycle_position 用） */
export function loadScheduleStateCheck(db: Db = getDb(), schemeId?: string): number {
  const id = schemeId ?? activeSchemeId(db);
  const rows = db
    .select({ id: schema.cycleTemplate.id })
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, id))
    .all();
  return rows.length;
}

/** 某个方案当前的生效锚点（最新一条） */
export function currentAnchor(db: Db = getDb(), schemeId?: string) {
  const id = schemeId ?? activeSchemeId(db);
  return (
    db
      .select()
      .from(schema.scheduleAnchor)
      .where(eq(schema.scheduleAnchor.schemeId, id))
      .orderBy(schema.scheduleAnchor.id)
      .all()
      .at(-1) ?? null
  );
}

export function pendingProposals(db: Db = getDb()) {
  return db
    .select()
    .from(schema.anchorProposal)
    .where(and(eq(schema.anchorProposal.status, "pending")))
    .orderBy(schema.anchorProposal.id)
    .all();
}

export function proposalById(db: Db, id: number) {
  return db.select().from(schema.anchorProposal).where(eq(schema.anchorProposal.id, id)).get() ?? null;
}
