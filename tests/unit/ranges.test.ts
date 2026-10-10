/**
 * 范围常量的单一来源（issue #28）。
 *
 * 以前同一批数字有三份（服务端 / 页面硬编码 / 文案字面），改一处漏一处就变成
 * "页面放行、接口拒绝"或"页面拦得比接口严"。这里钉住：**只有一份**，且页面直接引它。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAR_KG,
  BODY_FAT_PCT,
  BODY_WEIGHT_KG,
  CARDIO_MINUTES,
  REPS_RANGE,
  REST_SEC,
  SET_WEIGHT_KG,
} from "@/lib/caliber/ranges";
import { CARDIO_MAX_MINUTES, CARDIO_MIN_MINUTES } from "@/lib/caliber/cardio";
import { REST_SEC_MAX, REST_SEC_MIN } from "@/lib/caliber/rest";
import * as rules from "@/server/rules";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("范围常量只有一份（issue #28）", () => {
  it("server/rules 与 lib/caliber/ranges 是**同一个对象**（不是各抄一份）", () => {
    expect(rules.SET_WEIGHT_KG).toBe(SET_WEIGHT_KG);
    expect(rules.BODY_WEIGHT_KG).toBe(BODY_WEIGHT_KG);
    expect(rules.BODY_FAT_PCT).toBe(BODY_FAT_PCT);
    expect(rules.REPS_RANGE).toBe(REPS_RANGE);
  });

  it("组间歇 / 有氧的范围也从同一份派生（导出值一致）", () => {
    expect([REST_SEC_MIN, REST_SEC_MAX]).toEqual([REST_SEC.min, REST_SEC.max]);
    expect([CARDIO_MIN_MINUTES, CARDIO_MAX_MINUTES]).toEqual([CARDIO_MINUTES.min, CARDIO_MINUTES.max]);
  });

  it("口径本身没被顺手改掉（钉住当前值）", () => {
    expect(SET_WEIGHT_KG).toEqual({ min: 0, max: 400 });
    expect(BODY_WEIGHT_KG).toEqual({ min: 0, max: 400 });
    expect(BODY_FAT_PCT).toEqual({ min: 0, max: 75 });
    expect(REPS_RANGE).toEqual({ min: 0, max: 999 });
    expect(CARDIO_MINUTES).toEqual({ min: 1, max: 600 });
    expect(REST_SEC).toEqual({ min: 10, max: 600 });
    expect(BAR_KG).toEqual({ min: 0, max: 50 });
  });

  it("改一次上限，服务端拒绝跟着变（表驱动：边界内收、边界外拒）", () => {
    // 体脂：max 合法、max + 1 越界（同一个常量对象喂给断言与实现）
    const ok = rules.parseBodyMetricBody({ weight_kg: 70, body_fat_pct: BODY_FAT_PCT.max }, { defaultDate: "2026-10-09" });
    expect(ok.ok).toBe(true);
    const bad = rules.parseBodyMetricBody({ weight_kg: 70, body_fat_pct: BODY_FAT_PCT.max + 1 }, { defaultDate: "2026-10-09" });
    expect(bad.ok).toBe(false);

    // 次数：上限合法、上限 + 1 越界
    expect(rules.setReadingsIssue(20, REPS_RANGE.max)).toBeNull();
    expect(rules.setReadingsIssue(20, REPS_RANGE.max + 1)).not.toBeNull();

    // 有氧分钟：上限合法、上限 + 1 越界
    expect(rules.parseCardioBody({ date: "2026-10-09", minutes: CARDIO_MINUTES.max }, { today: "2026-10-09", yesterday: "2026-10-08" }).ok).toBe(true);
    expect(rules.parseCardioBody({ date: "2026-10-09", minutes: CARDIO_MINUTES.max + 1 }, { today: "2026-10-09", yesterday: "2026-10-08" }).ok).toBe(false);
  });

  it("src/app/** 里不再有业务范围的硬编码（只准由常量拼装）", () => {
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src", "app"))) {
      const src = readFileSync(file, "utf8");
      for (const pattern of [/max=\{999\}/, /max=\{600\}/, /max=\{400\}/, /max=\{75\}/, /＞\s*75/, /\bweight_kg > 400\b/, /fatValue > 75/]) {
        if (pattern.test(src)) offenders.push(`${file} ← ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
