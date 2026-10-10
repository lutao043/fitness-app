/**
 * 写接口校验 · supplement（issue #26 从 `server/rules.ts` 拆出；校验口径与拆分前逐字一致）。
 */

import { checkText, readBool, readTrimmed } from "./core";
import type { ParseResult } from "./core";

import { isValidTimeStr } from "@/lib/time";

/* ————————————————————————— 补剂清单（FR-33） ————————————————————————— */
export interface SupplementWrite {
  name?: string;
  times?: string[];
  doseText?: string;
  enabled?: boolean;
}

export function parseSupplementBody(
  body: Record<string, unknown>,
  opts: { requireName: boolean },
): ParseResult<SupplementWrite> {
  const issues: string[] = [];
  const value: SupplementWrite = {};

  if (body.name !== undefined || opts.requireName) {
    const name = readTrimmed(body.name);
    checkText(issues, "补剂名", name, 12, true);
    if (name) value.name = name;
  }
  if (body.times !== undefined || opts.requireName) {
    if (!Array.isArray(body.times)) {
      issues.push("times 必须是数组（HH:mm）");
    } else {
      const times: string[] = [];
      for (const raw of body.times) {
        const time = readTrimmed(raw);
        if (!time || !isValidTimeStr(time)) {
          issues.push(`提醒时点必须是 HH:mm：${String(raw)}`);
          break;
        }
        if (!times.includes(time)) times.push(time);
      }
      if (times.length > 4) issues.push("一个补剂最多 4 个提醒时点");
      else if (!issues.some((i) => i.includes("提醒时点"))) value.times = times;
    }
  }
  if (body.dose_text !== undefined || body.doseText !== undefined) {
    const dose = readTrimmed(body.dose_text ?? body.doseText) ?? "";
    if (dose.length > 40) issues.push("剂量文案最长 40 个字");
    else value.doseText = dose;
  } else if (opts.requireName) {
    value.doseText = "";
  }
  if (body.enabled !== undefined) {
    const enabled = readBool(body.enabled);
    if (enabled === undefined) issues.push("enabled 必须是布尔");
    else value.enabled = enabled;
  } else if (opts.requireName) {
    value.enabled = true;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}
