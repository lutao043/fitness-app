/**
 * 幂等写入口 · session（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { revertExtraTrainingShift } from "./checkin";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { DateStr } from "@/lib/time";

/* ———————————————————————— 训练会话 ———————————————————————— */

export interface SessionCreateInput {
  clientId: string;
  date: DateStr;
  part: string;
  mode: "gym" | "home";
  status: "planned" | "doing" | "done" | "aborted";
  templateId?: number | null;
  startedAt?: string | null;
  restTargetSec?: number;
  planSnapshot?: unknown;
  /** 加练（13.17）：非训练日真练了；开练时写循环位点 */
  isExtra?: boolean;
  exercises?: {
    exerciseId: number;
    orderNo: number;
    targetSets: number;
    targetReps: number;
  }[];
}

/** POST /sessions 的幂等键 = client_id（重复提交返回既有会话，不新建、不报错） */
export function createSession(
  db: Db,
  input: SessionCreateInput,
): { id: number; created: boolean } {
  const existing = db
    .select({ id: schema.workoutSession.id })
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.clientId, input.clientId))
    .get();
  if (existing) return { id: existing.id, created: false };

  return db.transaction((tx) => {
    const inserted = tx
      .insert(schema.workoutSession)
      .values({
        clientId: input.clientId,
        date: input.date,
        templateId: input.templateId ?? null,
        part: input.part,
        mode: input.mode,
        status: input.status,
        startedAt: input.startedAt ?? null,
        restTargetSec: input.restTargetSec ?? 90,
        planSnapshot: input.planSnapshot ?? null,
        isExtra: input.isExtra ?? false,
      })
      .returning({ id: schema.workoutSession.id })
      .get();

    (input.exercises ?? []).forEach((e) => {
      tx.insert(schema.sessionExercise)
        .values({
          sessionId: inserted.id,
          exerciseId: e.exerciseId,
          orderNo: e.orderNo,
          targetSets: e.targetSets,
          targetReps: e.targetReps,
        })
        .run();
    });
    return { id: inserted.id, created: true };
  });
}

export interface SessionPatch {
  status?: "planned" | "doing" | "done" | "aborted";
  part?: string;
  mode?: "gym" | "home";
  startedAt?: string | null;
  endedAt?: string | null;
  pausedSec?: number;
  restTargetSec?: number;
  planSnapshot?: unknown;
  summary?: unknown;
  feel?: string | null;
  note?: string | null;
}

export function updateSession(db: Db, id: number, patch: SessionPatch): { updated: boolean } {
  const res = db
    .update(schema.workoutSession)
    .set(patch as Record<string, unknown>)
    .where(eq(schema.workoutSession.id, id))
    .run();
  return { updated: res.changes > 0 };
}

/** planning 超时退回 idle：planned 会话直接删除（从未开始训练，无保留价值，4.2） */
export function deleteSession(db: Db, id: number): { removed: boolean } {
  const res = db.delete(schema.workoutSession).where(eq(schema.workoutSession.id, id)).run();
  return { removed: res.changes > 0 };
}

/**
 * 孤儿会话清理（4.2）：跨日后仍是 planned/doing 且 started_at 距今超过 24 小时的，
 * 由服务端每日自检置为 aborted —— 不算练完、不算出勤、不再豁免训练提醒。
 * 加练的位点一起撤（13.17：aborted 不算练完，排期也得回原样）。
 *
 * `ended_at` 的写法（13.3 v1.34 / issue #38）：**取这场会话最后一组的 `done_at`**，
 * 一组都没有就留 null。不写"清理时刻"—— 那会把"昨天练到一半没收到工"显示成 30 小时的
 * 训练时长；也不写 0 —— 组都没记过，时长就该是「—」。
 */
export function abortOrphanSessions(db: Db, now: number, hours = 24): number {
  const cutoff = new Date(now - hours * 3_600_000).toISOString();
  const condition = and(
    lt(schema.workoutSession.startedAt, cutoff),
    sql`${schema.workoutSession.status} in ('planned','doing')`,
  );
  const orphans = db
    .select({ id: schema.workoutSession.id, isExtra: schema.workoutSession.isExtra })
    .from(schema.workoutSession)
    .where(condition)
    .all();

  for (const orphan of orphans) {
    const lastSet = db
      .select({ doneAt: schema.setLog.doneAt })
      .from(schema.setLog)
      .where(eq(schema.setLog.sessionId, orphan.id))
      .orderBy(desc(schema.setLog.doneAt))
      .get();
    db.update(schema.workoutSession)
      .set({ status: "aborted", endedAt: lastSet?.doneAt ?? null })
      .where(eq(schema.workoutSession.id, orphan.id))
      .run();
    if (orphan.isExtra) revertExtraTrainingShift(db, orphan.id);
  }
  return orphans.length;
}

export interface SetLogInput {
  /** 客户端生成的幂等键（离线队列重试安全）；同一 key 重复提交 = 覆盖同一组 */
  clientKey: string;
  sessionId: number;
  exerciseId: number;
  setNo: number;
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  variantId?: number | null;
  totalLoadKg?: number | null;
  /** 本组开始时刻（FR-9 v1.50）：组间歇的起点是它、不是 doneAt */
  startedAt?: string | null;
  restBeforeSec?: number | null;
  sameExercise?: boolean;
  doneAt?: string;
  feel?: "easy" | "normal" | "hard" | "failure" | null;
  skipped?: boolean;
}

export function upsertSetLog(db: Db, input: SetLogInput): { id: number; created: boolean } {
  const values = {
    clientKey: input.clientKey,
    sessionId: input.sessionId,
    exerciseId: input.exerciseId,
    setNo: input.setNo,
    weightKg: input.weightKg ?? null,
    reps: input.reps ?? null,
    durationSec: input.durationSec ?? null,
    variantId: input.variantId ?? null,
    totalLoadKg: input.totalLoadKg ?? null,
    startedAt: input.startedAt ?? null,
    restBeforeSec: input.restBeforeSec ?? null,
    sameExercise: input.sameExercise ?? false,
    doneAt: input.doneAt ?? new Date().toISOString(),
    feel: input.feel ?? null,
    skipped: input.skipped ?? false,
  };
  const existing = db
    .select({ id: schema.setLog.id })
    .from(schema.setLog)
    .where(eq(schema.setLog.clientKey, input.clientKey))
    .get();
  if (existing) {
    db.update(schema.setLog).set(values).where(eq(schema.setLog.id, existing.id)).run();
    return { id: existing.id, created: false };
  }
  const inserted = db
    .insert(schema.setLog)
    .values(values)
    .returning({ id: schema.setLog.id })
    .get();
  return { id: inserted.id, created: true };
}

export function deleteSetLog(db: Db, id: number): { removed: boolean } {
  const res = db.delete(schema.setLog).where(eq(schema.setLog.id, id)).run();
  return { removed: res.changes > 0 };
}

/** 历史补记明细（13.4：打卡后允许事后补明细，不强制、不催） */
export function updateSetLog(
  db: Db,
  id: number,
  patch: {
    weightKg?: number | null;
    reps?: number | null;
    durationSec?: number | null;
    feel?: "easy" | "normal" | "hard" | "failure" | null;
    totalLoadKg?: number | null;
  },
): { updated: boolean } {
  // 只写"这次真的带了的字段"（undefined 不能进 set：会被 drizzle 当成非法值）
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  if (Object.keys(values).length === 0) return { updated: false };
  const res = db
    .update(schema.setLog)
    .set(values)
    .where(eq(schema.setLog.id, id))
    .run();
  return { updated: res.changes > 0 };
}
