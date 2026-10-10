/**
 * 幂等写入口 · scheme（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { loadScheduleState } from "@/db/queries";
import type { DateStr } from "@/lib/time";
import { slotIndexAt } from "@/lib/schedule";

/* ———————————————————————— 规则管理：分化方案 / 槽位（FR-21） ———————————————————————— */

/** 新增方案（可复制一个现有方案：槽位 + 两套动作清单一起复制） */
export function createScheme(
  db: Db,
  input: {
    id: string;
    name: string;
    note?: string;
    copyFrom?: string | null;
    /** 首次使用的锚点：以今天从第 1 位开始（原型 §4.6「首次使用某方案则从第 1 位开始」） */
    anchorDate: DateStr;
  },
): { id: string } {
  const orderNo =
    (db.select({ order: schema.splitScheme.orderNo }).from(schema.splitScheme).all().reduce((m, r) => Math.max(m, r.order), -1) ?? -1) + 1;
  return db.transaction((tx) => {
    tx.insert(schema.splitScheme)
      .values({ id: input.id, name: input.name, note: input.note ?? "", orderNo, active: false })
      .run();

    if (input.copyFrom) {
      const templates = tx
        .select()
        .from(schema.cycleTemplate)
        .where(eq(schema.cycleTemplate.schemeId, input.copyFrom))
        .orderBy(asc(schema.cycleTemplate.position))
        .all();
      for (const t of templates) {
        const inserted = tx
          .insert(schema.cycleTemplate)
          .values({
            schemeId: input.id,
            position: t.position,
            name: t.name,
            isRest: t.isRest,
            muscles: t.muscles ?? [],
          })
          .returning({ id: schema.cycleTemplate.id })
          .get();
        const rows = tx
          .select()
          .from(schema.cycleExercise)
          .where(eq(schema.cycleExercise.templateId, t.id))
          .all();
        for (const r of rows) {
          tx.insert(schema.cycleExercise)
            .values({
              templateId: inserted.id,
              mode: r.mode,
              exerciseId: r.exerciseId,
              orderNo: r.orderNo,
              targetSets: r.targetSets,
              targetReps: r.targetReps,
            })
            .run();
        }
      }
    }

    tx.insert(schema.scheduleAnchor)
      .values({
        schemeId: input.id,
        anchorDate: input.anchorDate,
        cyclePosition: 0,
        reason: "initial",
        note: "新建方案，从第 1 位开始",
      })
      .run();
    return { id: input.id };
  });
}

export function schemeById(db: Db, id: string) {
  return db.select().from(schema.splitScheme).where(eq(schema.splitScheme.id, id)).get() ?? null;
}

export function updateScheme(db: Db, id: string, patch: { name?: string; note?: string }): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.note !== undefined) values.note = patch.note;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.splitScheme).set(values).where(eq(schema.splitScheme.id, id)).run();
  return { updated: res.changes > 0 };
}

/** 删除方案：当前方案删不得，且至少要留一套（删掉就没排期可算了） */
export function deleteScheme(db: Db, id: string): { removed: boolean; error?: string } {
  const scheme = schemeById(db, id);
  if (!scheme) return { removed: false, error: "方案不存在" };
  if (scheme.active) return { removed: false, error: "当前正在用的方案删不了（先切到别的方案）" };
  const total = db.select({ id: schema.splitScheme.id }).from(schema.splitScheme).all().length;
  if (total <= 1) return { removed: false, error: "至少要留一套方案" };
  db.delete(schema.splitScheme).where(eq(schema.splitScheme.id, id)).run();
  return { removed: true };
}

/**
 * 切换当前方案（设计说明 §4.6：每方案各记自己的锚点，切回来**原样恢复**离开时的位次）。
 *
 * 落地方式（只追加锚点，不改历史）：
 * - 切走：给旧方案记一条 `switch_away` 锚点（今天 + 离开时的位次）；
 * - 切回：目标方案最近一条是 `switch_away` / `resume` → 今天按那条的位次重锚（= 原样恢复）；
 * - 首次真正启用某个方案（最近一条还是安装时的 `initial`）→ 今天从第 1 位开始。
 *
 * ⚠️ 因此切走再切回会给方案追加锚点：并行期（需求书 10.1）**保持默认方案不切**，
 * 否则与助手连续推算的循环会错位（设计说明 §4.7 同源约束）。
 */
export function switchActiveScheme(
  db: Db,
  targetId: string,
  today: DateStr,
): { previousId: string | null; resumed: boolean; from: string | null } {
  const previous = db.select().from(schema.splitScheme).where(eq(schema.splitScheme.active, true)).get() ?? null;
  if (previous?.id === targetId) return { previousId: targetId, resumed: false, from: null };
  const target = schemeById(db, targetId);
  if (!target) return { previousId: previous?.id ?? null, resumed: false, from: null };

  let previousPosition: number | null = null;
  if (previous) {
    const state = loadScheduleState(db, today);
    previousPosition = slotIndexAt(today, state.ctx);
  }

  return db.transaction((tx) => {
    if (previous && previousPosition !== null) {
      tx.insert(schema.scheduleAnchor)
        .values({
          schemeId: previous.id,
          anchorDate: today,
          cyclePosition: previousPosition,
          reason: "switch_away",
          note: `切到「${target.name}」`,
        })
        .run();
    }
    const latest =
      tx
        .select()
        .from(schema.scheduleAnchor)
        .where(eq(schema.scheduleAnchor.schemeId, targetId))
        .orderBy(desc(schema.scheduleAnchor.id))
        .get() ?? null;

    let resumed = false;
    let from: string | null = latest?.reason ?? null;
    if (!latest) {
      tx.insert(schema.scheduleAnchor)
        .values({
          schemeId: targetId,
          anchorDate: today,
          cyclePosition: 0,
          reason: "initial",
          note: "首次使用，从第 1 位开始",
        })
        .run();
    } else if (latest.reason === "switch_away" || latest.reason === "resume") {
      tx.insert(schema.scheduleAnchor)
        .values({
          schemeId: targetId,
          anchorDate: today,
          cyclePosition: latest.cyclePosition,
          reason: "resume",
          note: "切回原方案，按离开时的位次继续",
        })
        .run();
      resumed = true;
    } else if (latest.reason === "initial" && latest.anchorDate < today) {
      tx.insert(schema.scheduleAnchor)
        .values({ schemeId: targetId, anchorDate: today, cyclePosition: 0, reason: "resume", note: "首次使用，从第 1 位开始" })
        .run();
      from = "first_use";
    }

    tx.update(schema.splitScheme).set({ active: false }).run();
    tx.update(schema.splitScheme).set({ active: true }).where(eq(schema.splitScheme.id, targetId)).run();
    return { previousId: previous?.id ?? null, resumed, from };
  });
}

/* ———————————————————————— 规则管理：槽位与槽位动作清单（FR-21） ———————————————————————— */

export function templateById(db: Db, id: number) {
  return db.select().from(schema.cycleTemplate).where(eq(schema.cycleTemplate.id, id)).get() ?? null;
}

export function addSlot(
  db: Db,
  input: { schemeId: string; name: string; isRest?: boolean; muscles?: string[] },
): { id: number } {
  const current = db
    .select({ position: schema.cycleTemplate.position })
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, input.schemeId))
    .orderBy(desc(schema.cycleTemplate.position))
    .get();
  const position = (current?.position ?? -1) + 1;
  return db
    .insert(schema.cycleTemplate)
    .values({
      schemeId: input.schemeId,
      position,
      name: input.name,
      isRest: !!input.isRest,
      muscles: input.muscles ?? [],
    })
    .returning({ id: schema.cycleTemplate.id })
    .get();
}

export function updateSlot(
  db: Db,
  templateId: number,
  patch: { name?: string; isRest?: boolean; muscles?: string[] },
): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.isRest !== undefined) values.isRest = patch.isRest;
  if (patch.muscles !== undefined) values.muscles = patch.muscles;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.cycleTemplate).set(values).where(eq(schema.cycleTemplate.id, templateId)).run();
  return { updated: res.changes > 0 };
}

/** 槽位排序：与相邻槽位换位（唯一索引 (scheme, position)，中间借 -1 位挪一下） */
export function moveSlot(db: Db, templateId: number, direction: -1 | 1): { moved: boolean } {
  const row = templateById(db, templateId);
  if (!row) return { moved: false };
  const siblings = db
    .select()
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, row.schemeId))
    .orderBy(asc(schema.cycleTemplate.position))
    .all();
  const index = siblings.findIndex((s) => s.id === templateId);
  const target = siblings[index + direction];
  if (!target) return { moved: false };
  return db.transaction((tx) => {
    tx.update(schema.cycleTemplate).set({ position: -1 }).where(eq(schema.cycleTemplate.id, row.id)).run();
    tx.update(schema.cycleTemplate)
      .set({ position: row.position })
      .where(eq(schema.cycleTemplate.id, target.id))
      .run();
    tx.update(schema.cycleTemplate).set({ position: target.position }).where(eq(schema.cycleTemplate.id, row.id)).run();
    return { moved: true };
  });
}

/** 删槽位：至少要留一个（循环长度 = 槽位数，清零就没排期了） */
export function deleteSlot(db: Db, templateId: number): { removed: boolean; error?: string } {
  const row = templateById(db, templateId);
  if (!row) return { removed: false, error: "槽位不存在" };
  const count = db
    .select({ id: schema.cycleTemplate.id })
    .from(schema.cycleTemplate)
    .where(eq(schema.cycleTemplate.schemeId, row.schemeId))
    .all().length;
  if (count <= 1) return { removed: false, error: "每个方案至少要留一个槽位" };
  db.transaction((tx) => {
    tx.delete(schema.cycleTemplate).where(eq(schema.cycleTemplate.id, templateId)).run();
    // 后面的槽位往前顺一位，position 保持 0..N-1 连续
    const rest = tx
      .select()
      .from(schema.cycleTemplate)
      .where(eq(schema.cycleTemplate.schemeId, row.schemeId))
      .orderBy(asc(schema.cycleTemplate.position))
      .all();
    rest.forEach((t, index) => {
      if (t.position === index) return;
      tx.update(schema.cycleTemplate).set({ position: index }).where(eq(schema.cycleTemplate.id, t.id)).run();
    });
  });
  return { removed: true };
}

/** 槽位某一个场景（健身房 / 居家自重）的动作清单：**整表原子覆盖**（顺序 = 数组下标） */
export function replaceSlotExercises(
  db: Db,
  templateId: number,
  mode: "gym" | "home",
  list: { exerciseId: number; targetSets: number; targetReps: number }[],
): { count: number } {
  return db.transaction((tx) => {
    tx.delete(schema.cycleExercise)
      .where(and(eq(schema.cycleExercise.templateId, templateId), eq(schema.cycleExercise.mode, mode)))
      .run();
    list.forEach((entry, index) => {
      tx.insert(schema.cycleExercise)
        .values({
          templateId,
          mode,
          exerciseId: entry.exerciseId,
          orderNo: index,
          targetSets: entry.targetSets,
          targetReps: entry.targetReps,
        })
        .run();
    });
    return { count: list.length };
  });
}
