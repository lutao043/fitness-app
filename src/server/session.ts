/**
 * 训练会话的服务端逻辑：写一组（自动记组间歇 / 折算容量）、算小结。
 *
 * 写入时判定（都在服务端做，客户端只负责上报"完成了一组"）：
 * - `same_exercise`（13.5）：和上一组比"动作 + 器械变体"是否相同；
 * - `rest_before_sec`（13.5）：上一组完成 → 本组开始的实际活跃秒数，扣掉暂停（只扣一次）；
 * - `total_load_kg`（13.1 / 13.14）：按动作 loadMode + 变体读数语义折算，助力 / 弹力带不计容量。
 */

import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { exerciseById, variantById } from "@/db/writes";
import { sessionCompletionRows } from "@/db/queries";
import { restBeforeSec, restStats, sessionDurationSec, totalLoadKg } from "@/lib/caliber";
import { sessionCompletion } from "@/lib/session-progress";
import { setReadingsIssue } from "@/server/rules";
import type { LoadMode, LoadSemantics } from "@/lib/exercise/types";

export interface SessionSummary {
  totalSets: number;
  /** 容量（kg，按总重） */
  volumeKg: number;
  /**
   * 训练时长（秒，墙上时间 = `ended_at − started_at`，**含暂停**，13.3 v1.34 / issue #38）。
   * null = 两个时间戳缺一（补录 / 没有会话的打卡 / 未收工）—— 读侧显示「—」，不许当 0。
   */
  durationSec: number | null;
  /**
   * 上面那个的分钟取整。`durationSec` 为 null 时是 0 —— **只作数值兜底**，
   * 展示层要先判 `durationSec === null` 再决定显示「—」，不要直接显示这个 0。
   */
  minutes: number;
  /** 组间歇均值（秒，只算同动作同变体） */
  avgRestSec: number;
  /** 换项间隔均值（秒，跨动作单列，13.5） */
  avgChangeoverSec: number;
  sameRestSets: number;
  changeoverSets: number;
}

export interface WriteSetInput {
  clientKey: string;
  exerciseId: number;
  setNo: number;
  weightKg?: number | null;
  reps?: number | null;
  durationSec?: number | null;
  variantId?: number | null;
  doneAt: string;
  /** 上一组完成到本组开始之间累计的暂停毫秒（FR-42：只在一处扣） */
  pausedMsSincePrev?: number;
  feel?: "easy" | "normal" | "hard" | "failure" | null;
  /**
   * 历史补录（FR-13）：**不记组间歇**、也不参与 same_exercise 统计 ——
   * 补录时刻与上一组可能差几小时，算出来的"组间歇"是假的（13.5 v1.18）。
   */
  backfill?: boolean;
}

export interface WriteSetResult {
  id: number;
  created: boolean;
  restBeforeSec: number | null;
  sameExercise: boolean;
  totalLoadKg: number | null;
  volumeKg: number;
}

/**
 * 唯一真相在 `db/writes/exercise.ts`（issue #32）：这里只转发，避免两份实现日后各改一处。
 * `setReadingIssue` 也是同样的写法（转发到 `server/rules`）。
 */
export { exerciseById, variantById };

/**
 * 逐组读数的范围校验（issue #1 第 5 项）：脏数据会被「照上次填」当默认值回填，入库前挡住。
 * **唯一真相在 `server/rules.ts` 的 `setReadingsIssue`**（13.19 的范围表与那里的常量对齐）——
 * 这里只是保留旧名字给既有调用方。
 */
export function setReadingIssue(
  weightKg: number | null | undefined,
  reps: number | null | undefined,
): string | null {
  return setReadingsIssue(weightKg, reps);
}

/** 写一组：幂等（client_key）+ 自动组间歇 + 自动容量折算 */
export function writeSet(
  db: Db,
  sessionId: number,
  input: WriteSetInput,
): WriteSetResult | { error: string } {
  const readingIssue = setReadingIssue(input.weightKg, input.reps);
  if (readingIssue) return { error: readingIssue };

  const exercise = exerciseById(db, input.exerciseId);
  if (!exercise) return { error: `动作不存在：${input.exerciseId}` };
  const variant = input.variantId ? variantById(db, input.variantId) : null;
  if (input.variantId && (!variant || variant.exerciseId !== exercise.id)) {
    return { error: "器械变体与动作不匹配" };
  }

  const semantics: LoadSemantics = variant?.loadSemantics ?? "direct";
  const total = totalLoadKg({
    weightKg: input.weightKg ?? null,
    loadMode: exercise.loadMode as LoadMode,
    barKg: exercise.barKg,
    semantics,
  });
  const volumeKg =
    total !== null && input.reps ? Math.round(total * input.reps) : 0;

  // 这一条要落到的目标行（issue #34）：先按幂等键找，找不到再按「同一组」的四个字段兜底 ——
  // 老客户端（键尾带时间戳）连点两下算出的两个键不一样，只按 clientKey 去重会记出两条同 set_no 的组。
  // 命中「同一组」的既有行 = 改组（与 PATCH /sets/{setId} 同语义），返回 created: false。
  const existingByKey = db
    .select({ id: schema.setLog.id })
    .from(schema.setLog)
    .where(eq(schema.setLog.clientKey, input.clientKey))
    .get();
  const existingBySlot =
    existingByKey ??
    db
      .select({ id: schema.setLog.id })
      .from(schema.setLog)
      .where(
        and(
          eq(schema.setLog.sessionId, sessionId),
          eq(schema.setLog.exerciseId, input.exerciseId),
          input.variantId ? eq(schema.setLog.variantId, input.variantId) : isNull(schema.setLog.variantId),
          eq(schema.setLog.setNo, input.setNo),
        ),
      )
      .orderBy(desc(schema.setLog.id))
      .get();

  // 上一组 = 本场会话里 done_at 早于本组的最近一条（同一个动作和不同动作都算，用来判 same_exercise）；
  // 要落到的这一行本身不算"上一组"（改组时别把自己当间隔起点）
  const prev = db
    .select({
      exerciseId: schema.setLog.exerciseId,
      variantId: schema.setLog.variantId,
      doneAt: schema.setLog.doneAt,
    })
    .from(schema.setLog)
    .where(
      and(
        eq(schema.setLog.sessionId, sessionId),
        ne(schema.setLog.clientKey, input.clientKey),
        ne(schema.setLog.id, existingBySlot?.id ?? -1),
      ),
    )
    .orderBy(desc(schema.setLog.doneAt))
    .get();

  const prevDoneAt = prev?.doneAt ? Date.parse(prev.doneAt) : null;
  const nowTs = Date.parse(input.doneAt);
  const rest = input.backfill
    ? { restBeforeSec: null, sameExercise: false } // 补录：没有真实间隔，不编（13.5 v1.18）
    : restBeforeSec({
        prevDoneAt: prevDoneAt !== null && Number.isFinite(prevDoneAt) ? prevDoneAt : null,
        now: Number.isFinite(nowTs) ? nowTs : Date.now(),
        pausedMsBetween: input.pausedMsSincePrev ?? 0,
        prev: prev ? { exercise: String(prev.exerciseId), variantId: prev.variantId === null ? null : String(prev.variantId) } : null,
        current: {
          exercise: String(input.exerciseId),
          variantId: input.variantId === null || input.variantId === undefined ? null : String(input.variantId),
        },
      });

  const values = {
    clientKey: input.clientKey,
    sessionId,
    exerciseId: input.exerciseId,
    setNo: input.setNo,
    weightKg: input.weightKg ?? null,
    reps: input.reps ?? null,
    durationSec: input.durationSec ?? null,
    variantId: input.variantId ?? null,
    totalLoadKg: total,
    restBeforeSec: rest.restBeforeSec,
    sameExercise: rest.sameExercise,
    doneAt: input.doneAt,
    feel: input.feel ?? null,
    skipped: false,
  };

  if (existingBySlot) {
    // 覆盖同一行（含把 clientKey 写成新键：下一次重放就走上面的主路径）
    db.update(schema.setLog).set(values).where(eq(schema.setLog.id, existingBySlot.id)).run();
    return {
      id: existingBySlot.id,
      created: false,
      restBeforeSec: rest.restBeforeSec,
      sameExercise: rest.sameExercise,
      totalLoadKg: total,
      volumeKg,
    };
  }
  const inserted = db
    .insert(schema.setLog)
    .values(values)
    .returning({ id: schema.setLog.id })
    .get();
  return {
    id: inserted.id,
    created: true,
    restBeforeSec: rest.restBeforeSec,
    sameExercise: rest.sameExercise,
    totalLoadKg: total,
    volumeKg,
  };
}

/** 小结（FR-43）：总组数 / 总容量 / 时长 / 组间歇均值（同类与换项分开） */
export function computeSessionSummary(db: Db, sessionId: number): SessionSummary {
  const session = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  const sets = db
    .select({
      reps: schema.setLog.reps,
      totalLoadKg: schema.setLog.totalLoadKg,
      restBeforeSec: schema.setLog.restBeforeSec,
      sameExercise: schema.setLog.sameExercise,
      skipped: schema.setLog.skipped,
      isWarmup: schema.setLog.isWarmup,
    })
    .from(schema.setLog)
    .where(eq(schema.setLog.sessionId, sessionId))
    .orderBy(asc(schema.setLog.doneAt))
    .all();

  // skipped 与历史热身行都不算训练量（13.1 / 13.16）—— v1.26 起不再记录热身组，这条排除只为老数据保留；也不进组间歇统计（13.5）
  const counted = sets.filter((s) => !s.skipped && !s.isWarmup);
  const volumeKg = Math.round(
    counted.reduce((sum, s) => sum + (s.totalLoadKg ?? 0) * (s.reps ?? 0), 0),
  );
  const stats = restStats(counted.map((s) => ({ restBeforeSec: s.restBeforeSec, sameExercise: s.sameExercise })));

  const durationSec = sessionDurationSec(session?.startedAt, session?.endedAt);
  const minutes = durationSec === null ? 0 : Math.round(durationSec / 60);

  return {
    totalSets: counted.length,
    volumeKg,
    durationSec,
    minutes,
    avgRestSec: stats.sameExerciseAvgSec ?? 0,
    avgChangeoverSec: stats.changeoverAvgSec ?? 0,
    sameRestSets: stats.sameExerciseCount,
    changeoverSets: stats.changeoverCount,
  };
}

/**
 * 读侧补齐存量小结（v1.34 / issue #38）：库里落的旧小结没有 `durationSec`，且 `minutes` 曾是
 * "扣掉 paused_sec"的旧口径 —— 时长口径改过之后不能把这些行显示成错的数。
 * 只补这两个字段（其余字段原样），按会话自身的 started_at / ended_at 重算；
 * 新写的小结带 `durationSec`（哪怕是 null），原样返回、不重算。
 */
export function normalizeSummary(
  summary: unknown,
  session: { startedAt: string | null; endedAt: string | null } | null | undefined,
): SessionSummary | null {
  if (!summary || typeof summary !== "object") return null;
  const stored = summary as SessionSummary;
  if (stored.durationSec !== undefined) return stored;
  const durationSec = sessionDurationSec(session?.startedAt, session?.endedAt);
  return { ...stored, durationSec, minutes: durationSec === null ? 0 : Math.round(durationSec / 60) };
}

/**
 * 组明细变了就重算并**落库**小结（FR-13 v1.18）。
 * 落库是为了让所有读留存小结的地方（记录页列表、今日页"今天练完了"卡）同时更新 ——
 * 只在读取时算的话，改完一组回列表会看到旧的容量。
 * planned（从未开始）的会话没有小结可言，跳过。
 */
export function refreshSessionSummary(db: Db, sessionId: number): SessionSummary | null {
  const session = db
    .select({ status: schema.workoutSession.status })
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  if (!session) return null;
  if (session.status === "planned") return null;
  const summary = computeSessionSummary(db, sessionId);
  db.update(schema.workoutSession)
    .set({ summary })
    .where(eq(schema.workoutSession.id, sessionId))
    .run();
  return summary;
}

/** 会话列表（历史页与详情页共用） */
export function setsOfSession(db: Db, sessionId: number) {
  return db
    .select()
    .from(schema.setLog)
    .where(eq(schema.setLog.sessionId, sessionId))
    .orderBy(asc(schema.setLog.doneAt))
    .all();
}

/**
 * 完成度（issue #45 / v1.47）：**服务端算一处**，记录页与今日页都读它 —— 两处显示的组数 / 完成度
 * 必须逐字一致（`sessionCompletion` 是纯函数：主标 = 已记组数 / 目标之和；副标的分母只算记过组的动作）。
 */
export function sessionCompletionOf(
  db: Db,
  sessionId: number,
): { setsText: string; exercisesText: string; totalSets: number } {
  const rows = sessionCompletionRows(db, sessionId);
  const totalSets = rows.reduce((sum, r) => sum + r.doneSets, 0);
  const completion = sessionCompletion(rows, totalSets);
  return { ...completion, totalSets };
}
