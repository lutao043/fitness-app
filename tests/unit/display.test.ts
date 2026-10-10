/**
 * 从页面搬出来的判定逻辑（issue #25）：日期换算、文案拼装、数字格式、趋势点组装。
 * 这些以前写在组件文件里，天生不可测 —— 现在都在 `src/lib/**`，在这儿钉住。
 */

import { describe, expect, it } from "vitest";
import { dayLabel, daysUntil, monthDay, monthLabel } from "@/lib/time";
import { compactNumber, sessionRowMeta } from "@/lib/display";
import { weightTrendLines } from "@/lib/chart/series";

describe("日期换算（今日页搬出来）", () => {
  it("daysUntil：同日 0、往后正数、往前一律 0（不出现负数）", () => {
    expect(daysUntil("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysUntil("2026-10-09", "2026-10-12")).toBe(3);
    expect(daysUntil("2026-10-12", "2026-10-09")).toBe(0);
  });

  it("daysUntil：坏值不崩（给 0，而不是 NaN 渲染到页面上）", () => {
    expect(daysUntil("", "2026-10-09")).toBe(0);
    expect(daysUntil("2026-10-09", "昨天")).toBe(0);
  });

  it("跨月 / 跨年按真实天数（不是按自然月差）", () => {
    expect(daysUntil("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysUntil("2026-12-30", "2027-01-02")).toBe(3);
  });

  it("monthDay：「10月12日」，不补零、不带年份", () => {
    expect(monthDay("2026-10-12")).toBe("10月12日");
    expect(monthDay("2026-01-05")).toBe("1月5日");
  });

  it("dayLabel：只有当天加「今天 ·」前缀", () => {
    expect(dayLabel("2026-10-09", "2026-10-09")).toBe("今天 · 10月9日 周五");
    expect(dayLabel("2026-10-08", "2026-10-09")).toBe("10月8日 周四");
  });

  it("monthLabel：记录页按月分隔用「2026 年 10 月」", () => {
    expect(monthLabel("2026-10-01")).toBe("2026 年 10 月");
    expect(monthLabel("2026-01-31")).toBe("2026 年 1 月");
  });
});

describe("数字与文案（记录页搬出来）", () => {
  it("compactNumber：一万以上缩写成 k（49.1k 这种）", () => {
    expect(compactNumber(9999)).toBe("9999");
    expect(compactNumber(10000)).toBe("10k");
    expect(compactNumber(49100)).toBe("49.1k");
    expect(compactNumber(5160)).toBe("5160");
    expect(compactNumber(Number.NaN)).toBe("0");
  });

  it("sessionRowMeta：有重量数据给容量，没有就退回训练场景（不显示 0 kg）", () => {
    expect(sessionRowMeta({ volumeKg: 5160, mode: "gym" }, "kg")).toBe("容量 5160 kg");
    expect(sessionRowMeta({ volumeKg: 5160, mode: "gym" }, "lb")).toBe("容量 11376 lb");
    expect(sessionRowMeta({ volumeKg: 0, mode: "home" }, "kg")).toBe("居家自重");
    expect(sessionRowMeta({ volumeKg: null, mode: "gym" }, "kg")).toBe("健身房");
    expect(sessionRowMeta({}, "kg")).toBe("健身房");
  });

  it("weightTrendLines：没有重量数据的那天不产生点（按 0 画会造假下降）", () => {
    const lines = weightTrendLines(
      [
        { date: "2026-10-01", maxWeightKg: 20 },
        { date: "2026-10-02", maxWeightKg: null },
        { date: "2026-10-03", maxWeightKg: 22.5 },
      ],
      "kg",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].points.map((p) => p.date)).toEqual(["2026-10-01", "2026-10-03"]);
    expect(lines[0].points.map((p) => p.value)).toEqual([20, 22.5]);
  });

  it("weightTrendLines：切 lb 只改展示值，库里的 kg 不动；全空则不给线", () => {
    const lb = weightTrendLines([{ date: "2026-10-01", maxWeightKg: 20 }], "lb");
    expect(lb[0].points[0].value).toBe(44.1);
    expect(weightTrendLines([{ date: "2026-10-01", maxWeightKg: null }], "kg")).toEqual([]);
    expect(weightTrendLines([], "kg")).toEqual([]);
  });
});
