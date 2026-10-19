/**
 * 写接口校验 · records（issue #26 从 `server/rules.ts` 拆出；校验口径与拆分前逐字一致）。
 */

import { readBool, readExplicit, readNumber, readTrimmed } from "./core";
import type { ParseResult } from "./core";

import { isValidDateStr, isValidTimeStr } from "@/lib/time";
import { CARDIO_MAX_MINUTES, CARDIO_MIN_MINUTES } from "@/lib/caliber/cardio";
import { BODY_FAT_PCT, BODY_WEIGHT_KG, REPS_RANGE, SET_WEIGHT_KG } from "@/lib/caliber/ranges";

/* ————————————————————————— 记录类写接口（13.1 / 13.2 / 13.8 / FR-50 / FR-57） ————————————————————————— */

/**
 * 记录类字段的**范围常量 —— 这里是唯一真相**（issue #14）：需求书 13.19 的「写接口字段范围表」
 * 逐项与它们对齐；接口层、页面、助手三条路径共用同一份。以前每个 route 各写一份判断，
 * 于是同一个字段出现两套口径（`weight` 在记一组里 0 合法、在体重里 0 非法）。
 *
 * ⚠️ 两个「0 的口径不同」是**故意的**，别合并：
 * - 记一组的读数 `SET_WEIGHT_KG`：**0 合法** —— 试举失败 / 没上重量 / 提前收工都不算错（13.1）
 * - 体重 `BODY_WEIGHT_KG`：**0 不是一次称重**（13.2）
 */
// 范围常量**只有一份**（issue #28）：定义在 `src/lib/caliber/ranges.ts`，页面直接引那一份，
// 这里 re-export 给接口层 —— 改一次上限，页面提示与服务端拒绝同时跟着变。
export { SET_WEIGHT_KG, BODY_WEIGHT_KG, BODY_FAT_PCT, REPS_RANGE, CARDIO_MINUTES, REST_SEC, BAR_KG } from "@/lib/caliber/ranges";
export const SET_FEELS = ["easy", "normal", "hard", "failure"] as const;
export const BODY_SLOTS = ["morning", "bedtime", "other"] as const;
export const SKIP_REASONS = ["missed", "overtime", "holiday", "manual"] as const;
export const ANALYSIS_LEVELS = ["normal", "watch", "suspect"] as const;
export const ANALYSIS_TEXT_MAX = 800;
export const SESSION_STATUSES = ["planned", "doing", "done", "aborted"] as const;
export const SESSION_MODES = ["gym", "home"] as const;

/**
 * 记一组 / 改一组的读数校验（13.1）：0 合法、出界整条拒绝。
 * 返回 `null` = 通过（`session.ts` 的 `setReadingIssue` 与 `parseSetBody` 都走这里，别各写一份）。
 */
export function setReadingsIssue(
  weightKg: number | null | undefined,
  reps: number | null | undefined,
): string | null {
  if (weightKg !== null && weightKg !== undefined) {
    if (weightKg < SET_WEIGHT_KG.min || weightKg > SET_WEIGHT_KG.max) {
      return `weight_kg 必须在 ${SET_WEIGHT_KG.min}~${SET_WEIGHT_KG.max} 之间`;
    }
  }
  if (reps !== null && reps !== undefined) {
    if (!Number.isInteger(reps) || reps < REPS_RANGE.min || reps > REPS_RANGE.max) {
      return `reps 必须是 ${REPS_RANGE.min}~${REPS_RANGE.max} 的整数`;
    }
  }
  return null;
}

export interface BodyMetricWrite {
  date: string;
  slot: (typeof BODY_SLOTS)[number];
  weightKg: number;
  bodyFatPct: number | null;
  note: string | null;
}

/**
 * 记体重（13.2）：`{date?, slot?, weight_kg, body_fat_pct?, note?}`。
 * `slot` 缺省 = `morning`；**任何越界 / 非数字都整条拒绝**（v1.26 起 `body_fat_pct` 也校验 ——
 * 以前 100 / -3 静默入库；「存在但非数字」同样拒绝，别被 `readNumber` 吞成 null）。
 */
export function parseBodyMetricBody(
  body: Record<string, unknown>,
  opts: { defaultDate: string },
): ParseResult<BodyMetricWrite> {
  const issues: string[] = [];

  const date = readTrimmed(body.date) ?? opts.defaultDate;
  if (!isValidDateStr(date)) issues.push("date 不是合法日期（YYYY-MM-DD）");

  const rawSlot = body.slot === undefined ? "morning" : readTrimmed(body.slot);
  const slot = BODY_SLOTS.find((s) => s === rawSlot);
  if (!slot) issues.push(`slot 只能是 ${BODY_SLOTS.join(" / ")}`);

  const weight = readNumber(body.weight_kg ?? body.weightKg);
  if (weight === undefined || weight <= BODY_WEIGHT_KG.min || weight > BODY_WEIGHT_KG.max) {
    issues.push(`weight_kg 必须是 ${BODY_WEIGHT_KG.min}~${BODY_WEIGHT_KG.max} 之间的数字`);
  }

  let bodyFatPct: number | null = null;
  const rawFat = readExplicit(body, ["body_fat_pct", "bodyFatPct"]);
  if (rawFat !== undefined && rawFat !== null) {
    const fat = readNumber(rawFat);
    if (fat === undefined || fat < BODY_FAT_PCT.min || fat > BODY_FAT_PCT.max) {
      issues.push(`body_fat_pct 必须是 ${BODY_FAT_PCT.min}~${BODY_FAT_PCT.max} 之间的数字`);
    } else {
      bodyFatPct = fat;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      date,
      slot: slot as BodyMetricWrite["slot"],
      weightKg: weight as number,
      bodyFatPct,
      note: readTrimmed(body.note) ?? null,
    },
  };
}

export interface SetWrite {
  clientKey: string;
  exerciseId: number;
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  durationSec: number | null;
  variantId: number | null;
  /** 本组开始时刻（FR-9 v1.50 / issue #75）；没点过【开始这组】就是 null */
  startedAt: string | null;
  doneAt: string;
  pausedMsSincePrev: number;
  feel: (typeof SET_FEELS)[number] | null;
  backfill: boolean;
}

/**
 * 记一组（13.1 / 13.14 / FR-13 / FR-11 / FR-53 / FR-9 v1.50）：
 * 读数越界整条拒绝（**0 合法**）；`feel` 非法值 **400**（不再静默当"没标"）；
 * `is_warmup: true` **400**（v1.26 起不再记录热身组）；
 * `started_at` 给了就得能解析（它决定组间歇 = 上一组完成 → 本组开始，13.5）；
 * 给了但解析不了 → 400（不静默吞成 null：那会把"点过开始"的组变成"没点"）。
 */
export function parseSetBody(
  body: Record<string, unknown>,
  opts: { defaultClientKey: string; defaultDoneAt: string },
): ParseResult<SetWrite> {
  const issues: string[] = [];

  const clientKey = readTrimmed(body.client_key ?? body.clientKey) ?? opts.defaultClientKey;

  const exerciseId = readNumber(body.exercise_id ?? body.exerciseId);
  if (!exerciseId) issues.push("缺少 exercise_id");

  // 读数：缺省 = null（留空合法，第 12 章第 14 条：不做必填校验）；**给了就得是有限数字且在范围内** ——
  // 「存在但非数字」（如 "abc"）同样 400，别被 readNumber 吞成 null 静默丢读数
  const rawWeight = readExplicit(body, ["weight_kg", "weightKg"]);
  let weightKg: number | null = null;
  if (rawWeight !== undefined && rawWeight !== null) {
    const parsed = readNumber(rawWeight);
    if (parsed === undefined) issues.push("weight_kg 必须是 0~400 之间的数字（或留空）");
    else weightKg = parsed;
  }
  const rawReps = readExplicit(body, ["reps"]);
  let reps: number | null = null;
  if (rawReps !== undefined && rawReps !== null) {
    const parsed = readNumber(rawReps);
    if (parsed === undefined) issues.push("reps 必须是 0~999 的整数（或留空）");
    else reps = parsed;
  }
  const readingIssue = setReadingsIssue(weightKg, reps);
  if (readingIssue) issues.push(readingIssue);

  // 感受（FR-11）：可以不标；**给了非枚举值一律 400**，别静默当"没标"
  const rawFeel = readExplicit(body, ["feel"]);
  let feel: SetWrite["feel"] = null;
  if (rawFeel !== undefined && rawFeel !== null) {
    const parsedFeel = SET_FEELS.find((f) => f === readTrimmed(rawFeel));
    if (!parsedFeel) issues.push(`feel 只能是 ${SET_FEELS.join(" / ")}`);
    else feel = parsedFeel;
  }

  // 热身组已取消（v1.26）：传 true 一律 400（不做静默忽略）
  if (readBool(body.is_warmup ?? body.isWarmup) === true) {
    issues.push("热身组不再记录（v1.26 起改为练前提示）：别传 is_warmup: true");
  }

  // 本组开始时刻（FR-9 v1.50）：缺省 = null（忘点开始 / 补录 —— 这一组不记组间歇，13.5）
  const rawStartedAt = readTrimmed(body.started_at ?? body.startedAt);
  let startedAt: string | null = null;
  if (rawStartedAt) {
    if (!Number.isFinite(Date.parse(rawStartedAt))) issues.push("started_at 不是合法时间戳（ISO 8601）");
    else startedAt = rawStartedAt;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      clientKey,
      exerciseId: exerciseId as number,
      setNo: readNumber(body.set_no ?? body.setNo) ?? 1,
      weightKg,
      reps,
      durationSec: readNumber(body.duration_sec ?? body.durationSec) ?? null,
      variantId: readNumber(body.variant_id ?? body.variantId) ?? null,
      startedAt,
      doneAt: readTrimmed(body.done_at ?? body.doneAt) ?? opts.defaultDoneAt,
      pausedMsSincePrev: readNumber(body.paused_ms_since_prev ?? body.pausedMsSincePrev) ?? 0,
      feel,
      backfill: readBool(body.backfill) ?? false,
    },
  };
}

export interface SkipWrite {
  date: string;
  reason: (typeof SKIP_REASONS)[number];
  confirm: boolean;
  note: string | null;
}

/**
 * 顺延（13.8）：`{date?, reason?, confirm?, note?}`。
 * `reason` 走白名单 —— **缺省仍是 `missed`（缺省不是非法），传了非枚举值一律 400**
 * （以前静默改写成 `missed`，调用方拼错时对不上账；v1.26 / issue #10 R2）。
 */
export function parseSkipBody(
  body: Record<string, unknown>,
  opts: { defaultDate: string },
): ParseResult<SkipWrite> {
  const issues: string[] = [];

  const date = readTrimmed(body.date) ?? opts.defaultDate;
  if (!isValidDateStr(date)) issues.push("date 不是合法日期（YYYY-MM-DD）");

  const rawReason = readExplicit(body, ["reason"]);
  let reason: SkipWrite["reason"] = "missed";
  if (rawReason !== undefined && rawReason !== null) {
    const parsedReason = SKIP_REASONS.find((r) => r === readTrimmed(rawReason));
    if (!parsedReason) issues.push(`reason 取值只能是 ${SKIP_REASONS.join(" / ")}`);
    else reason = parsedReason;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { date, reason, confirm: readBool(body.confirm) ?? false, note: readTrimmed(body.note) ?? null },
  };
}

export interface CardioWrite {
  date: string;
  minutes: number;
  note: string | null;
}

/**
 * 记有氧（FR-50）：`{date?, minutes, note?}`。`minutes` 1~600 整数（常量在 `lib/caliber/cardio`，
 * 与 13.1 的读数校验同源）；`date` **只允许今天 / 昨天**（13.3 的按天归属）。
 */
export function parseCardioBody(
  body: Record<string, unknown>,
  opts: { today: string; yesterday: string },
): ParseResult<CardioWrite> {
  const issues: string[] = [];

  const date = readTrimmed(body.date) ?? opts.today;
  if (!isValidDateStr(date)) issues.push("date 不是合法日期（YYYY-MM-DD）");
  else if (date > opts.today) issues.push("不能记未来的日期");
  else if (date < opts.yesterday) issues.push("有氧只能记今天或昨天");

  const minutes = readNumber(body.minutes);
  if (
    minutes === undefined ||
    !Number.isInteger(minutes) ||
    minutes < CARDIO_MIN_MINUTES ||
    minutes > CARDIO_MAX_MINUTES
  ) {
    issues.push(`minutes 必须是 ${CARDIO_MIN_MINUTES}~${CARDIO_MAX_MINUTES} 的整数`);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { date, minutes: minutes as number, note: readTrimmed(body.note) ?? null } };
}

export interface OvertimeWrite {
  date?: string;
  start?: string;
  note?: string | null;
}

/** 录 / 改加班（FR-22 / 3.3）：`date` 合法日期、`start` 必须 `HH:mm`；POST 两栏都必填，PATCH 只校验带来的字段。 */
export function parseOvertimeBody(
  body: Record<string, unknown>,
  opts: { requireAll: boolean; defaultDate: string },
): ParseResult<OvertimeWrite> {
  const issues: string[] = [];
  const value: OvertimeWrite = {};

  if (body.date !== undefined || opts.requireAll) {
    const date = readTrimmed(body.date) ?? (opts.requireAll ? opts.defaultDate : undefined);
    if (date === undefined) issues.push("date 不是合法日期（YYYY-MM-DD）");
    else if (!isValidDateStr(date)) {
      issues.push(opts.requireAll ? "date 不是合法日期（YYYY-MM-DD）" : "date 不是合法日期");
    } else value.date = date;
  }

  if (body.start !== undefined || opts.requireAll) {
    const start = readTrimmed(body.start);
    if (!start || !isValidTimeStr(start)) {
      issues.push(opts.requireAll ? "start 必须是 HH:mm（如 20:00）" : "start 必须是 HH:mm");
    } else {
      value.start = start;
    }
  }

  if (body.note !== undefined) value.note = readTrimmed(body.note) ?? null;

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

export interface ReanchorWrite {
  date: string;
  cyclePosition: number;
  reason: string;
  note: string | null;
}

/** 重锚（FR-23 / FR-38）：`cycle_position` 必须是 `0..槽位数-1` 的整数（越界 400，别让它算出越界槽位）。 */
export function parseReanchorBody(
  body: Record<string, unknown>,
  opts: { defaultDate: string; cycleLen: number },
): ParseResult<ReanchorWrite> {
  const issues: string[] = [];

  const date = readTrimmed(body.date) ?? opts.defaultDate;
  if (!isValidDateStr(date)) issues.push("date 不是合法日期（YYYY-MM-DD）");

  const position = readNumber(body.cycle_position ?? body.cyclePosition);
  if (position === undefined || !Number.isInteger(position)) {
    issues.push("cycle_position 必须是整数（0..槽位数-1）");
  } else if (position < 0 || position >= opts.cycleLen) {
    issues.push(`cycle_position 必须在 0..${opts.cycleLen - 1} 之间`);
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      date,
      cyclePosition: position as number,
      reason: readTrimmed(body.reason) ?? "manual",
      note: readTrimmed(body.note) ?? null,
    },
  };
}

export interface BodyAnalysisWrite {
  date: string;
  level: (typeof ANALYSIS_LEVELS)[number];
  text: string;
}

/** 每日体重分析（FR-57 / v1.29）：`level` 白名单、`text` 1~800 字（超长 / 空都 400）。 */
export function parseBodyAnalysisBody(
  body: Record<string, unknown>,
  opts: { defaultDate: string },
): ParseResult<BodyAnalysisWrite> {
  const issues: string[] = [];

  const date = readTrimmed(body.date) ?? opts.defaultDate;
  if (!isValidDateStr(date)) issues.push("date 不是合法日期（YYYY-MM-DD）");

  const rawLevel = readExplicit(body, ["level"]);
  const level = ANALYSIS_LEVELS.find((l) => l === readTrimmed(rawLevel));
  if (!level) issues.push(`level 取值只能是 ${ANALYSIS_LEVELS.join(" / ")}`);

  const text = readTrimmed(body.text);
  if (!text) issues.push("text 不能为空");
  else if (text.length > ANALYSIS_TEXT_MAX) {
    issues.push(`text 不能超过 ${ANALYSIS_TEXT_MAX} 字（当前 ${text.length} 字）`);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { date, level: level as BodyAnalysisWrite["level"], text: text as string } };
}

export interface SessionPatchWrite {
  status?: (typeof SESSION_STATUSES)[number];
  part?: string;
  mode?: (typeof SESSION_MODES)[number];
  startedAt?: string;
  endedAt?: string;
  pausedSec?: number;
  restTargetSec?: number;
  feel?: (typeof SET_FEELS)[number] | null;
  note?: string | null;
  planSnapshot?: unknown;
}

/**
 * 改会话（FR-12 / FR-43 / FR-4）：**枚举类字段（status / mode / feel）非法值一律 400**，
 * 不静默当"没传"（issue #14 第 4 条 —— 以前 `oneOf(...)` 会把拼错的状态悄悄丢掉）。
 */
export function parseSessionPatchBody(body: Record<string, unknown>): ParseResult<SessionPatchWrite> {
  const issues: string[] = [];
  const value: SessionPatchWrite = {};

  if (body.status !== undefined) {
    const status = SESSION_STATUSES.find((s) => s === readTrimmed(body.status));
    if (!status) issues.push(`status 只能是 ${SESSION_STATUSES.join(" / ")}`);
    else value.status = status;
  }
  if (body.mode !== undefined) {
    const mode = SESSION_MODES.find((m) => m === readTrimmed(body.mode));
    if (!mode) issues.push(`mode 只能是 ${SESSION_MODES.join(" / ")}`);
    else value.mode = mode;
  }
  const part = readTrimmed(body.part);
  if (part !== undefined) value.part = part;
  const startedAt = readTrimmed(body.started_at ?? body.startedAt);
  if (startedAt !== undefined) value.startedAt = startedAt;
  const endedAt = readTrimmed(body.ended_at ?? body.endedAt);
  if (endedAt !== undefined) value.endedAt = endedAt;
  if (body.paused_sec !== undefined || body.pausedSec !== undefined) {
    value.pausedSec = readNumber(body.paused_sec ?? body.pausedSec);
  }
  if (body.rest_target_sec !== undefined || body.restTargetSec !== undefined) {
    value.restTargetSec = readNumber(body.rest_target_sec ?? body.restTargetSec);
  }
  const rawFeel = readExplicit(body, ["feel"]);
  if (rawFeel !== undefined) {
    if (rawFeel === null || rawFeel === "") value.feel = null;
    else {
      const feel = SET_FEELS.find((f) => f === readTrimmed(rawFeel));
      if (!feel) issues.push(`feel 只能是 ${SET_FEELS.join(" / ")}`);
      else value.feel = feel;
    }
  }
  if (body.note !== undefined) value.note = readTrimmed(body.note) ?? null;
  if (body.plan_snapshot !== undefined || body.planSnapshot !== undefined) {
    value.planSnapshot = body.plan_snapshot ?? body.planSnapshot;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}
