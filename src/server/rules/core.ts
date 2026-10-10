/**
 * 公共词表与通用校验（issue #26 从 `server/rules.ts` 拆出；校验口径与拆分前逐字一致）。
 */

import { TAXONOMY } from "@/data";

/**
 * 规则管理（v1.2：方案 / 槽位 / 动作库 / 补剂）的入参校验与词表。
 *
 * 口径出处：第 6 章数据模型（槽位名同方案内唯一、动作名唯一）、13.14（器械是变体的属性）、
 * 13.15（细分肌群 15 项落库，大部位只是展示映射）、FR-33（补剂清单完全可编辑）。
 * 页面与助手两条调用路径共用这里的行为；接口层只负责鉴权与调用。
 */


/** 细分肌群 15 项（13.15，落库口径） */
export const FINE_MUSCLES: readonly string[] = TAXONOMY.fine;
/** 器械 8 种（13.14：器械是变体的属性，不是名字的一部分） */
export const EQUIPS: readonly string[] = TAXONOMY.equips;
export const SEMANTICS = ["direct", "ratio_2to1", "assist", "band"] as const;
export const LOAD_MODES = ["barbell", "dumbbell", "machine", "bodyweight", "single_side"] as const;
export const EXERCISE_TYPES = ["weight", "reps", "time"] as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTrimmed(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function readBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 取一个**可能被显式置空**的字段（`null` = 清掉，是有效输入）。
 * 不能用 `a ?? b` 串：空值合并会把 `null` 也跳过，于是 `{base: null}` 会掉进"参数不合法"。
 */
export function readExplicit(body: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in body) return body[key];
  }
  return undefined;
}

/** 肌群数组：必须来自细分肌群 15 项、非空、去重 */
export function readMuscles(value: unknown, issues: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push("muscles 必须是数组");
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const name = readTrimmed(item);
    if (!name || !FINE_MUSCLES.includes(name)) {
      issues.push(`muscles 里有不认识的肌群：${String(item)}`);
      return undefined;
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) {
    issues.push("muscles 至少要有一个肌群");
    return undefined;
  }
  return out;
}

export function checkText(issues: string[], label: string, text: string | undefined, max: number, required: boolean) {
  if (text === undefined) {
    if (required) issues.push(`${label}必填`);
    return;
  }
  if (text.length === 0 && required) issues.push(`${label}必填`);
  else if (text.length > max) issues.push(`${label}最长 ${max} 个字`);
}
