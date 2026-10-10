/**
 * 鼓励语（issue #33 / v1.39）：词库 + 纯函数选取。
 *
 * 两条硬要求：**相邻不重复**、**池空有兜底**；文案红线（第 12 章第 2/3/4 条）也在这儿钉住。
 */

import { describe, expect, it } from "vitest";
import { ENCOURAGEMENT_FALLBACK, pickEncouragement } from "@/lib/coach/pick";
import encouragements from "@/data/encouragements.json";

describe("pickEncouragement", () => {
  it("同一个种子稳定出同一句（刷新页面不会跳）", () => {
    const pool = ["甲", "乙", "丙"];
    expect(pickEncouragement(pool, 42)).toBe(pickEncouragement(pool, 42));
  });

  it("连抽 10 次（种子各不同）无相邻重复", () => {
    const pool = encouragements.rest;
    let previous: string | null = null;
    for (let i = 1; i <= 10; i++) {
      const line = pickEncouragement(pool, i * 7, previous);
      expect(line).not.toBe(previous);
      previous = line;
    }
  });

  it("撞上同一句时顺延一句（而不是硬重复）", () => {
    const pool = ["甲", "乙"];
    // seed=0 → 甲；previous=甲 → 顺延到乙
    expect(pickEncouragement(pool, 0, "甲")).toBe("乙");
    expect(pickEncouragement(pool, 0, "乙")).toBe("甲");
  });

  it("池空 / 坏数据 → 兜底，不渲染空白", () => {
    expect(pickEncouragement([], 3)).toBe(ENCOURAGEMENT_FALLBACK);
    expect(pickEncouragement(["", "   "], 3)).toBe(ENCOURAGEMENT_FALLBACK);
    expect(pickEncouragement([1, null, {}] as unknown[], 3)).toBe(ENCOURAGEMENT_FALLBACK);
  });

  it("池里只有一句时允许重复（没有别的可选）", () => {
    expect(pickEncouragement(["只有一句"], 5, "只有一句")).toBe("只有一句");
  });

  it("种子是坏数（NaN / 负数 / 小数）也不崩", () => {
    const pool = ["甲", "乙", "丙"];
    expect(pool).toContain(pickEncouragement(pool, Number.NaN));
    expect(pool).toContain(pickEncouragement(pool, -3));
    expect(pool).toContain(pickEncouragement(pool, 1.9));
  });
});

describe("词库本身（src/data/encouragements.json）", () => {
  it("两组文案都非空", () => {
    expect(encouragements.rest.length).toBeGreaterThanOrEqual(1);
    expect(encouragements.empty.length).toBeGreaterThanOrEqual(1);
  });

  it("守住文案红线：不推荐蛋白粉 / 不写增肌话术 / 不做卡路里账 / 不用命令式", () => {
    for (const line of [...encouragements.rest, ...encouragements.empty]) {
      expect(line).not.toMatch(/蛋白粉|增肌|卡路里|热量|加油吧|必须|一定要|不准/);
      expect(line.trim()).toBe(line);
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});
