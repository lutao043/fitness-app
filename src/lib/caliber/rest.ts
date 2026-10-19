/**
 * 组间歇与换项间隔（需求书 13.5 / FR-9 / FR-42）。
 *
 * - `rest_before_sec` = 上一组完成 → 本组**开始**的**真实活跃秒数**；
 * - **"本组开始" = `set_log.started_at`**（v1.50 / issue #75）：以前调用方传的是"本组完成"时刻，
 *   于是本组自身的做组耗时被算进了休息（均值系统性偏大）—— 参数名从 `now` 改成 `startedAt`，
 *   就是为了让这个错误没法再犯一次；
 * - **没有 `started_at`（忘点开始 / 老数据 / 补录）= 没有真实间隔** → `restBeforeSec` 写 null，
 *   与 13.5「补录的组没有组间歇」同一条口径（不退回"完成 − 完成"的旧算法，那会混两种口径）；
 * - 暂停时长从两侧都扣掉，**只扣一次**（原型踩过"暂停双扣"：暂停 60s 记成负数）；
 * - `same_exercise` 在写入时判定：同动作 + 同器械变体连做 → true；换了动作 → false；
 * - 组间歇均值只统计 `same_exercise = true` 的组；跨动作的单列「换项间隔」；
 * - 每个动作的第一组没有 `rest_before_sec`（null），不参与任何均值。
 */

import { REST_SEC } from "./ranges";

export interface RestContextInput {
  /** 上一组完成的时间戳（ms）；第一组传 null */
  prevDoneAt: number | null;
  /** 本组**开始**的时间戳（ms，= `set_log.started_at`）；没有开始时刻传 null */
  startedAt: number | null;
  /** 两组之间累计的暂停毫秒（FR-42；只在这一处扣） */
  pausedMsBetween?: number;
  prev: { exercise: string; variantId?: string | null } | null;
  current: { exercise: string; variantId?: string | null };
}

export interface RestResult {
  restBeforeSec: number | null;
  sameExercise: boolean;
}

export function restBeforeSec(input: RestContextInput): RestResult {
  const sameExercise = input.prev
    ? input.prev.exercise === input.current.exercise &&
      (input.prev.variantId ?? null) === (input.current.variantId ?? null)
    : false;

  if (input.prevDoneAt === null || !input.prev || input.startedAt === null) {
    return { restBeforeSec: null, sameExercise };
  }
  const active = input.startedAt - input.prevDoneAt - (input.pausedMsBetween ?? 0);
  const sec = Math.round(active / 1000);
  // 时钟回拨 / 数据异常导致的负数当"没有有效间隔"，不要写进库里
  return { restBeforeSec: sec < 0 ? null : sec, sameExercise };
}

export interface RestStats {
  /** 组间歇均值（秒，只算同动作同变体的组）；没有样本时 null */
  sameExerciseAvgSec: number | null;
  /** 换项间隔均值（秒，跨动作的组）；没有样本时 null */
  changeoverAvgSec: number | null;
  sameExerciseCount: number;
  changeoverCount: number;
}

/** 组间歇的上下限（秒）：与设置页的全局默认、动作库的动作级默认同一档（FR-52） */
/** 组间歇秒数范围：唯一真相在 `./ranges`（issue #28） */
export const REST_SEC_MIN = REST_SEC.min;
export const REST_SEC_MAX = REST_SEC.max;
export const DEFAULT_REST_SEC = 90;

/**
 * 一个动作的组间歇生效值（FR-52），优先级从高到低：
 * ① 本次临时改档（训练页点的那三档）→ ② 动作级默认（`exercise.rest_sec`）→ ③ 会话/全局默认。
 * 纯函数，抽出来是为了能脱离 React 单测（训练页只是调用方）。
 */
export function effectiveRestSec(input: {
  /** 本次临时改档（只影响这次训练） */
  overrideSec?: number | null;
  /** 动作库里的动作级默认 */
  exerciseRestSec?: number | null;
  /** 兜底：本次会话开始时的默认（来自 settings.rest_default_sec） */
  sessionRestSec: number;
}): number {
  for (const candidate of [input.overrideSec, input.exerciseRestSec, input.sessionRestSec]) {
    if (candidate !== null && candidate !== undefined && Number.isFinite(candidate) && candidate > 0) {
      return Math.round(candidate);
    }
  }
  return DEFAULT_REST_SEC;
}

/** 小结 / 周报的统计口径（FR-43）：两类间隔分开算，绝不混进同一个均值。 */
export function restStats(rows: readonly { restBeforeSec: number | null; sameExercise: boolean }[]): RestStats {
  const same: number[] = [];
  const change: number[] = [];
  for (const r of rows) {
    if (r.restBeforeSec === null) continue;
    (r.sameExercise ? same : change).push(r.restBeforeSec);
  }
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    sameExerciseAvgSec: avg(same),
    changeoverAvgSec: avg(change),
    sameExerciseCount: same.length,
    changeoverCount: change.length,
  };
}
