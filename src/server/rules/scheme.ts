/**
 * 写接口校验 · scheme（issue #26 从 `server/rules.ts` 拆出；校验口径与拆分前逐字一致）。
 */

import { FINE_MUSCLES, checkText, isPlainObject, readBool, readMuscles, readNumber, readTrimmed } from "./core";
import type { ParseResult } from "./core";

/* ————————————————————————— 分化方案 / 槽位 ————————————————————————— */

export function parseSchemeBody(
  body: Record<string, unknown>,
  opts: { requireName: boolean },
): ParseResult<{ name?: string; note?: string }> {
  const issues: string[] = [];
  const value: { name?: string; note?: string } = {};
  if (body.name !== undefined || opts.requireName) {
    const name = readTrimmed(body.name);
    checkText(issues, "方案名", name, 12, true);
    if (name) value.name = name;
  }
  if (body.note !== undefined) {
    const note = body.note === null ? "" : readTrimmed(body.note);
    if (note === undefined) issues.push("note 必须是字符串");
    else if (note.length > 100) issues.push("说明最长 100 个字");
    else value.note = note;
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

export function parseSlotBody(
  body: Record<string, unknown>,
  opts: { requireName: boolean },
): ParseResult<{ name?: string; isRest?: boolean; muscles?: string[] }> {
  const issues: string[] = [];
  const value: { name?: string; isRest?: boolean; muscles?: string[] } = {};
  if (body.name !== undefined || body.label !== undefined || opts.requireName) {
    const name = readTrimmed(body.name ?? body.label);
    checkText(issues, "槽位名", name, 12, true);
    if (name) value.name = name;
  }
  if (body.rest !== undefined || body.is_rest !== undefined || body.isRest !== undefined) {
    const rest = readBool(body.rest ?? body.is_rest ?? body.isRest);
    if (rest === undefined) issues.push("rest 必须是布尔（是不是「休」日）");
    else value.isRest = rest;
  } else if (opts.requireName) {
    value.isRest = false;
  }
  if (body.muscles !== undefined) {
    const muscles = readMuscles(body.muscles, issues);
    if (muscles) value.muscles = muscles;
  } else if (opts.requireName) {
    value.muscles = [];
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

export interface SlotExerciseEntry {
  exerciseId: number;
  targetSets: number;
  targetReps: number;
}

/** 槽位某一套清单（健身房 / 居家自重）：整表覆盖，顺序 = 数组顺序 */
export function parseSlotExercises(
  body: Record<string, unknown>,
): ParseResult<{ mode: "gym" | "home"; list: SlotExerciseEntry[] }> {
  const issues: string[] = [];
  const mode = readTrimmed(body.mode) ?? "gym";
  if (mode !== "gym" && mode !== "home") issues.push('mode 只能是 "gym" 或 "home"');

  if (!Array.isArray(body.exercises)) {
    return { ok: false, issues: [...issues, "exercises 必须是数组（可以是空数组）"] };
  }
  if (body.exercises.length > 30) issues.push("一个槽位最多 30 个动作");

  const list: SlotExerciseEntry[] = [];
  const seen = new Set<number>();
  body.exercises.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push(`第 ${index + 1} 项不是对象`);
      return;
    }
    const exerciseId = readNumber(raw.exercise_id ?? raw.exerciseId);
    if (exerciseId === undefined || !Number.isInteger(exerciseId)) {
      issues.push(`第 ${index + 1} 项缺少 exercise_id`);
      return;
    }
    if (seen.has(exerciseId)) {
      issues.push(`第 ${index + 1} 项与前面的动作重复`);
      return;
    }
    seen.add(exerciseId);
    const sets = readNumber(raw.sets ?? raw.target_sets ?? raw.targetSets);
    const reps = readNumber(raw.reps ?? raw.target_reps ?? raw.targetReps);
    if (sets === undefined || !Number.isInteger(sets) || sets < 1 || sets > 20) issues.push(`第 ${index + 1} 项的目标组数必须是 1~20`);
    if (reps === undefined || !Number.isInteger(reps) || reps < 1 || reps > 999) issues.push(`第 ${index + 1} 项的目标次数必须是 1~999`);
    if (issues.length === 0) list.push({ exerciseId, targetSets: sets as number, targetReps: reps as number });
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { mode: mode as "gym" | "home", list } };
}

/* ————————————————————————— 方案导出 / 导入（FR-54） ————————————————————————— */

/** 导出文件的类型标识：导入时先认它，避免把别的 JSON 塞进来 */
export const SCHEME_EXPORT_KIND = "fitness-app.scheme";
export const SCHEME_EXPORT_VERSION = 1;
/** 一套方案最多几个槽位（循环长度；超过正常分化方案的量级） */
export const SCHEME_MAX_SLOTS = 12;

export interface SchemeImportEntry {
  name: string;
  sets: number;
  reps: number;
}

export interface SchemeImportSlot {
  label: string;
  rest: boolean;
  muscles: string[];
  gym: SchemeImportEntry[];
  home: SchemeImportEntry[];
}

export interface SchemeImport {
  name: string;
  note: string;
  slots: SchemeImportSlot[];
}

function parseImportList(value: unknown, issues: string[], label: string): SchemeImportEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label} 必须是数组`);
    return [];
  }
  if (value.length > 30) {
    issues.push(`${label} 最多 30 个动作`);
    return [];
  }
  const out: SchemeImportEntry[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      issues.push(`${label} 第 ${index + 1} 项不是对象`);
      return;
    }
    const name = readTrimmed(raw.name);
    if (!name) {
      issues.push(`${label} 第 ${index + 1} 项缺少动作名`);
      return;
    }
    if (seen.has(name)) {
      issues.push(`${label} 第 ${index + 1} 项与前面的动作重名（同一个槽位里不能重复）`);
      return;
    }
    seen.add(name);
    const sets = readNumber(raw.sets);
    const reps = readNumber(raw.reps);
    if (sets === undefined || !Number.isInteger(sets) || sets < 1 || sets > 20) {
      issues.push(`${label}「${name}」的目标组数必须是 1~20`);
      return;
    }
    if (reps === undefined || !Number.isInteger(reps) || reps < 1 || reps > 999) {
      issues.push(`${label}「${name}」的目标次数必须是 1~999`);
      return;
    }
    out.push({ name, sets, reps });
  });
  return out;
}

/** 导入的肌群：逐项校验词表、去重；**允许空数组**（「休」槽位本来就不标肌群） */
function readImportMuscles(value: unknown, issues: string[], at: string): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${at}的 muscles 必须是数组`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const name = readTrimmed(item);
    if (!name || !FINE_MUSCLES.includes(name)) {
      issues.push(`${at}的 muscles 里有不认识的肌群：${String(item)}`);
      return undefined;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 导入的方案 JSON（FR-54）：只做**形状与范围**校验；动作名 → id 的解析在接口层做
 * （要查库，纯校验这里不碰数据库）。
 */
export function parseSchemeImportBody(body: Record<string, unknown>): ParseResult<SchemeImport> {
  const issues: string[] = [];
  if (body.kind !== SCHEME_EXPORT_KIND) {
    issues.push(`这不像本 App 导出的方案文件（kind 应该是 "${SCHEME_EXPORT_KIND}"）`);
  }
  if (body.version !== SCHEME_EXPORT_VERSION) {
    issues.push(`方案文件版本不认识：${String(body.version)}（当前支持 ${SCHEME_EXPORT_VERSION}）`);
  }

  const name = readTrimmed(body.name);
  if (!name) issues.push("缺少方案名 name");
  else if (name.length > 12) issues.push("方案名最长 12 个字（导入前先改短）");
  const note = body.note === undefined || body.note === null ? "" : (readTrimmed(body.note) ?? "");
  if (note.length > 100) issues.push("说明最长 100 个字");

  if (!Array.isArray(body.slots) || body.slots.length === 0) {
    issues.push("slots 必须是非空数组（循环长度 = 槽位数）");
    return { ok: false, issues };
  }
  if (body.slots.length > SCHEME_MAX_SLOTS) issues.push(`一套方案最多 ${SCHEME_MAX_SLOTS} 个槽位`);

  const slots: SchemeImportSlot[] = [];
  const labels = new Set<string>();
  body.slots.forEach((raw, index) => {
    const at = `第 ${index + 1} 个槽位`;
    if (!isPlainObject(raw)) {
      issues.push(`${at}不是对象`);
      return;
    }
    const label = readTrimmed(raw.label ?? raw.name);
    if (!label) {
      issues.push(`${at}缺少部位名 label`);
      return;
    }
    if (label.length > 12) issues.push(`${at}的部位名最长 12 个字`);
    if (labels.has(label)) issues.push(`${at}的部位名「${label}」与前面重复（同一方案内必须唯一）`);
    labels.add(label);

    const rest = raw.rest === true;
    const muscles = readImportMuscles(raw.muscles, issues, at);
    if (muscles === undefined) return;

    const gym = parseImportList(raw.gym, issues, `${at}的健身房清单`);
    const home = parseImportList(raw.home, issues, `${at}的居家清单`);
    slots.push({ label, rest, muscles, gym, home });
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { name: name!, note, slots } };
}
