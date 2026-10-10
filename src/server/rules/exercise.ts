/**
 * 写接口校验 · exercise（issue #26 从 `server/rules.ts` 拆出；校验口径与拆分前逐字一致）。
 */

import { EQUIPS, EXERCISE_TYPES, LOAD_MODES, SEMANTICS, checkText, readBool, readExplicit, readMuscles, readNumber, readTrimmed } from "./core";
import type { ParseResult } from "./core";

import type { ExerciseType, LoadMode, LoadSemantics } from "@/lib/exercise/types";
import { REST_SEC } from "@/lib/caliber/ranges";

/* ————————————————————————— 动作库（含器械变体） ————————————————————————— */

export interface ExerciseWrite {
  name?: string;
  muscles?: string[];
  type?: ExerciseType;
  equip?: string;
  loadMode?: LoadMode;
  barKg?: number | null;
  defaultSets?: number;
  defaultReps?: number;
  baseWeight?: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52） */
  restSec?: number | null;
  homeOk?: boolean;
  note?: string | null;
}

/** 动作级组间歇允许的范围（秒）—— 与设置页的全局默认同档（10~600） */
export const REST_SEC_MIN = REST_SEC.min;
export const REST_SEC_MAX = REST_SEC.max;

/**
 * 动作的新增 / 编辑入参。`requireAll` = 新增（全部必填），编辑时只校验带来的字段。
 * 范围口径与 13.1 的读数范围一致：参考重量 0~400、组数 1~20、次数/秒数 1~999。
 */
export function parseExerciseBody(body: Record<string, unknown>, opts: { requireAll: boolean }): ParseResult<ExerciseWrite> {
  const issues: string[] = [];
  const value: ExerciseWrite = {};

  if (body.name !== undefined || opts.requireAll) {
    const name = readTrimmed(body.name);
    checkText(issues, "动作名", name, 24, true);
    if (name) value.name = name;
  }
  if (body.muscles !== undefined || opts.requireAll) {
    const muscles = readMuscles(body.muscles, issues);
    if (muscles) value.muscles = muscles;
  }
  if (body.type !== undefined || opts.requireAll) {
    const type = readTrimmed(body.type);
    if (!type || !(EXERCISE_TYPES as readonly string[]).includes(type)) {
      issues.push(`type 只能是 ${EXERCISE_TYPES.join(" / ")}`);
    } else {
      value.type = type as ExerciseType;
    }
  }
  if (body.equip !== undefined || opts.requireAll) {
    const equip = readTrimmed(body.equip);
    if (!equip || !EQUIPS.includes(equip)) issues.push(`equip 只能是：${EQUIPS.join(" / ")}`);
    else value.equip = equip;
  }
  if (body.load_mode !== undefined || body.loadMode !== undefined || opts.requireAll) {
    const mode = readTrimmed(body.load_mode ?? body.loadMode);
    if (!mode || !(LOAD_MODES as readonly string[]).includes(mode)) {
      issues.push(`load_mode 只能是 ${LOAD_MODES.join(" / ")}`);
    } else {
      value.loadMode = mode as LoadMode;
    }
  }
  if (body.bar_kg !== undefined || body.barKg !== undefined) {
    const raw = body.bar_kg ?? body.barKg;
    if (raw === null) value.barKg = null;
    else {
      const barKg = readNumber(raw);
      if (barKg === undefined || barKg < 0 || barKg > 50) issues.push("bar_kg 必须在 0~50 之间");
      else value.barKg = barKg;
    }
  } else if (opts.requireAll && value.loadMode === "barbell") {
    value.barKg = 20; // 杠铃默认含杠 20 kg（13.1）
  }
  if (value.loadMode !== undefined && value.loadMode !== "barbell" && !opts.requireAll && value.barKg === undefined) {
    value.barKg = null; // 换成非杠铃口径时把杠重清掉，避免留下无意义的数
  }
  if (body.sets !== undefined || body.default_sets !== undefined || body.defaultSets !== undefined || opts.requireAll) {
    const sets = readNumber(body.sets ?? body.default_sets ?? body.defaultSets);
    if (sets === undefined || !Number.isInteger(sets) || sets < 1 || sets > 20) issues.push("默认组数必须是 1~20 的整数");
    else value.defaultSets = sets;
  }
  if (body.reps !== undefined || body.default_reps !== undefined || body.defaultReps !== undefined || opts.requireAll) {
    const reps = readNumber(body.reps ?? body.default_reps ?? body.defaultReps);
    if (reps === undefined || !Number.isInteger(reps) || reps < 1 || reps > 999) {
      issues.push("默认次数/秒数必须是 1~999 的整数");
    } else {
      value.defaultReps = reps;
    }
  }
  const rawBaseWeight = readExplicit(body, ["base", "base_weight", "baseWeight"]);
  if (rawBaseWeight !== undefined) {
    if (rawBaseWeight === null || rawBaseWeight === "") value.baseWeight = null;
    else {
      const base = readNumber(rawBaseWeight);
      if (base === undefined || base < 0 || base > 400) issues.push("参考重量必须在 0~400 之间（单侧 kg）");
      else value.baseWeight = base;
    }
  }
  const rawRest = readExplicit(body, ["rest", "rest_sec", "restSec"]);
  if (rawRest !== undefined) {
    if (rawRest === null || rawRest === "") {
      value.restSec = null; // 清掉 = 回到全局默认
    } else {
      const restSec = readNumber(rawRest);
      if (restSec === undefined || !Number.isInteger(restSec) || restSec < REST_SEC_MIN || restSec > REST_SEC_MAX) {
        issues.push(`组间歇必须是 ${REST_SEC_MIN}~${REST_SEC_MAX} 的整数（秒），或留空用全局默认`);
      } else {
        value.restSec = restSec;
      }
    }
  }
  if (body.home_ok !== undefined || body.homeOk !== undefined) {
    const homeOk = readBool(body.home_ok ?? body.homeOk);
    if (homeOk === undefined) issues.push("home_ok 必须是布尔");
    else value.homeOk = homeOk;
  }
  if (body.note !== undefined) {
    const note = body.note === null ? "" : readTrimmed(body.note);
    if (note !== undefined && note.length > 60) issues.push("备注最长 60 个字");
    else value.note = note ?? null;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

export interface VariantWrite {
  equip?: string;
  semantics?: LoadSemantics;
  label?: string;
  baseWeight?: number | null;
  /** 读数单位（v1.38 / issue #36）：`"kg" | "lb"`；**null = 跟随全局设置**（显式传 null 也是合法值） */
  readUnit?: "kg" | "lb" | null;
}

export function parseVariantBody(body: Record<string, unknown>, opts: { requireAll: boolean }): ParseResult<VariantWrite> {
  const issues: string[] = [];
  const value: VariantWrite = {};

  if (body.equip !== undefined || opts.requireAll) {
    const equip = readTrimmed(body.equip);
    if (!equip || !EQUIPS.includes(equip)) issues.push(`equip 只能是：${EQUIPS.join(" / ")}`);
    else value.equip = equip;
  }
  if (body.semantics !== undefined || opts.requireAll) {
    const semantics = readTrimmed(body.semantics);
    if (!semantics || !(SEMANTICS as readonly string[]).includes(semantics)) {
      issues.push(`readings 语义只能是 ${SEMANTICS.join(" / ")}（direct / ratio_2to1 / assist / band）`);
    } else {
      value.semantics = semantics as LoadSemantics;
    }
  }
  if (body.label !== undefined || opts.requireAll) {
    const label = readTrimmed(body.label) ?? "";
    if (label.length > 24) issues.push("变体备注最长 24 个字");
    else value.label = label;
  }
  const rawVariantBase = readExplicit(body, ["base", "base_weight", "baseWeight"]);
  if (rawVariantBase !== undefined) {
    if (rawVariantBase === null || rawVariantBase === "") value.baseWeight = null;
    else {
      const base = readNumber(rawVariantBase);
      if (base === undefined || base < 0 || base > 400) issues.push("变体参考重量必须在 0~400 之间（单侧 kg）");
      else value.baseWeight = base;
    }
  } else if (opts.requireAll) {
    value.baseWeight = null;
  }

  // 读数单位（v1.38）：不传 = 不动；传 null / 空串 = "跟随全局"
  const rawReadUnit = readExplicit(body, ["read_unit", "readUnit"]);
  if (rawReadUnit !== undefined) {
    if (rawReadUnit === null || rawReadUnit === "") value.readUnit = null;
    else {
      const unit = readTrimmed(rawReadUnit);
      if (unit !== "kg" && unit !== "lb") issues.push("读数单位只能是 kg / lb（不传 = 跟随全局设置）");
      else value.readUnit = unit;
    }
  } else if (opts.requireAll) {
    value.readUnit = null;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}
