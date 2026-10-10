/**
 * 幂等写入口 · session-exercise（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { semanticsForEquip } from "@/lib/exercise/types";
import { totalLoadKg } from "@/lib/caliber/load";
import type { LoadMode } from "@/lib/exercise/types";

/* ———————————————————————— 会话内的动作清单（FR-10 的 doing 阶段） ———————————————————————— */

export function sessionExerciseById(db: Db, id: number) {
  return db.select().from(schema.sessionExercise).where(eq(schema.sessionExercise.id, id)).get() ?? null;
}

/** 本次会话里某个动作已记的组数（换动作 / 移出今天的二次确认与删除依据） */
export function countSetsOfExercise(db: Db, sessionId: number, exerciseId: number): number {
  return db
    .select({ id: schema.setLog.id })
    .from(schema.setLog)
    .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.exerciseId, exerciseId)))
    .all().length;
}

/** 训练中加一个动作：加在末尾（只影响本次会话，不动模板 —— 要长期生效走计划页的「存回模板」） */
export function addSessionExercise(
  db: Db,
  input: { sessionId: number; exerciseId: number; targetSets: number; targetReps: number },
): { id: number; orderNo: number } {
  const last = db
    .select({ orderNo: schema.sessionExercise.orderNo })
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, input.sessionId))
    .orderBy(desc(schema.sessionExercise.orderNo))
    .get();
  const orderNo = (last?.orderNo ?? -1) + 1;
  const inserted = db
    .insert(schema.sessionExercise)
    .values({
      sessionId: input.sessionId,
      exerciseId: input.exerciseId,
      orderNo,
      targetSets: input.targetSets,
      targetReps: input.targetReps,
      status: "pending",
    })
    .returning({ id: schema.sessionExercise.id })
    .get();
  return { id: inserted.id, orderNo };
}

export function updateSessionExercise(
  db: Db,
  id: number,
  patch: { exerciseId?: number; targetSets?: number; targetReps?: number },
): { updated: boolean } {
  const values: Record<string, unknown> = {};
  if (patch.exerciseId !== undefined) values.exerciseId = patch.exerciseId;
  if (patch.targetSets !== undefined) values.targetSets = patch.targetSets;
  if (patch.targetReps !== undefined) values.targetReps = patch.targetReps;
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db.update(schema.sessionExercise).set(values).where(eq(schema.sessionExercise.id, id)).run();
  return { updated: res.changes > 0 };
}

/**
 * 调顺序：`up` / `down` 与相邻换位，`first` 把这条挪到最前（= 「先做这个」，
 * 器械被占时先做别的；「当前动作」是页面按"第一个没做满的动作"算的，挪到最前就轮到它）。
 */
export function reorderSessionExercise(db: Db, id: number, move: "up" | "down" | "first"): { moved: boolean } {
  const row = sessionExerciseById(db, id);
  if (!row) return { moved: false };
  const siblings = db
    .select()
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, row.sessionId))
    .orderBy(asc(schema.sessionExercise.orderNo))
    .all();
  const index = siblings.findIndex((s) => s.id === id);
  if (index < 0) return { moved: false };
  const targetIndex = move === "first" ? 0 : index + (move === "up" ? -1 : 1);
  if (targetIndex === index || targetIndex < 0 || targetIndex >= siblings.length) return { moved: false };

  const reordered = [...siblings];
  reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, row);
  db.transaction((tx) => {
    reordered.forEach((s, orderNo) => {
      if (s.orderNo === orderNo) return;
      tx.update(schema.sessionExercise).set({ orderNo }).where(eq(schema.sessionExercise.id, s.id)).run();
    });
  });
  return { moved: true };
}

/** 把清单重排成 0..N-1（移出 / 换位后用），避免空号影响展示 */
export function resequenceSessionExercises(db: Db, sessionId: number): void {
  const rows = db
    .select()
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, sessionId))
    .orderBy(asc(schema.sessionExercise.orderNo))
    .all();
  db.transaction((tx) => {
    rows.forEach((r, index) => {
      if (r.orderNo === index) return;
      tx.update(schema.sessionExercise).set({ orderNo: index }).where(eq(schema.sessionExercise.id, r.id)).run();
    });
  });
}

/**
 * 移出今天的清单。`withSets` = 连这一动作本次已记的组一起删（原型 §4.9 的约定：
 * 「已记的组会丢掉」必须二次确认过），否则只删清单行、组记录留着。
 */
export function removeSessionExercise(
  db: Db,
  id: number,
  opts: { withSets: boolean },
): { removed: boolean; deletedSets: number } {
  const row = sessionExerciseById(db, id);
  if (!row) return { removed: false, deletedSets: 0 };
  let deletedSets = 0;
  db.transaction((tx) => {
    if (opts.withSets) {
      const res = tx
        .delete(schema.setLog)
        .where(and(eq(schema.setLog.sessionId, row.sessionId), eq(schema.setLog.exerciseId, row.exerciseId)))
        .run();
      deletedSets = res.changes;
    }
    tx.delete(schema.sessionExercise).where(eq(schema.sessionExercise.id, id)).run();
  });
  resequenceSessionExercises(db, row.sessionId);
  return { removed: true, deletedSets };
}

/**
 * 「换动作」：把某动作在**本次会话里已记的全部组**整体搬到另一个动作名下（issue #43 / v1.46）。
 *
 * 与 PATCH 的 `exercise_id` 换动作的区别（那条会**连组一起删掉**）：这条是**修正记错的动作**，
 * 所以：
 * - `set_log.exercise_id` 就地更新；`weight_kg / reps / duration_sec / feel / is_warmup / done_at / set_no`
 *   **原样保留**；**`rest_before_sec` 与 `same_exercise` 也原样保留**（不许按"补录"重算成 null ——
 *   这正是这条接口存在的意义：删了重补会把组间歇弄丢，13.5）；
 * - `total_load_kg` 按**新动作**的 `loadMode / barKg / 默认变体语义` **重算**（13.1 / 13.14）；
 *   变体是动作的属性，跨动作搬不走 → `variant_id` 清空（该组回到新动作的默认变体）；
 * - 旧动作那行 `session_exercise` 一起处理：目标动作已在清单里就把旧行**删掉**（不留 0 组的僵尸行），
 *   否则把旧行改成新动作；
 * - **已收工（done）也允许**（事后发现记错动作是合法修正）；`aborting` 的会话由调用方挡住；
 * - 同一个动作 → `changed: false`，不写任何东西。
 */
export function moveExerciseSets(
  db: Db,
  input: {
    sessionId: number;
    fromExerciseId: number;
    toExerciseId: number;
  },
): {
  changed: boolean;
  movedSets: number;
  volumeBeforeKg: number;
  volumeAfterKg: number;
  targetHadRow: boolean;
} {
  const sets = db
    .select()
    .from(schema.setLog)
    .where(and(eq(schema.setLog.sessionId, input.sessionId), eq(schema.setLog.exerciseId, input.fromExerciseId)))
    .orderBy(asc(schema.setLog.id))
    .all();
  if (input.fromExerciseId === input.toExerciseId || sets.length === 0) {
    return { changed: false, movedSets: 0, volumeBeforeKg: 0, volumeAfterKg: 0, targetHadRow: false };
  }

  const to = db.select().from(schema.exercise).where(eq(schema.exercise.id, input.toExerciseId)).get();
  if (!to) {
    throw new Error(`动作不存在：${input.toExerciseId}`);
  }
  // 新动作的默认变体语义（变体跨动作搬不走，所以按默认变体算）
  const semantics = semanticsForEquip(to.equip);

  const volumeBefore = sets.reduce((sum, s) => sum + (s.totalLoadKg ?? 0) * (s.reps ?? 0), 0);
  let volumeAfter = 0;
  for (const set of sets) {
    const total = totalLoadKg({
      weightKg: set.weightKg,
      loadMode: to.loadMode as LoadMode,
      barKg: to.barKg,
      semantics,
    });
    volumeAfter += (total ?? 0) * (set.reps ?? 0);
    db.update(schema.setLog)
      .set({ exerciseId: input.toExerciseId, variantId: null, totalLoadKg: total })
      .where(eq(schema.setLog.id, set.id))
      .run();
  }

  // 清单行：目标动作已在清单里 → 删掉旧行（别留 0 组的僵尸行）；否则把旧行改成新动作
  const rows = db
    .select()
    .from(schema.sessionExercise)
    .where(eq(schema.sessionExercise.sessionId, input.sessionId))
    .all();
  const fromRow = rows.find((r) => r.exerciseId === input.fromExerciseId) ?? null;
  const targetRow = rows.find((r) => r.exerciseId === input.toExerciseId) ?? null;
  if (fromRow) {
    if (targetRow) {
      db.delete(schema.sessionExercise).where(eq(schema.sessionExercise.id, fromRow.id)).run();
      resequenceSessionExercises(db, input.sessionId);
    } else {
      db.update(schema.sessionExercise)
        .set({ exerciseId: input.toExerciseId })
        .where(eq(schema.sessionExercise.id, fromRow.id))
        .run();
    }
  }

  return {
    changed: true,
    movedSets: sets.length,
    volumeBeforeKg: Math.round(volumeBefore),
    volumeAfterKg: Math.round(volumeAfter),
    targetHadRow: !!targetRow,
  };
}
