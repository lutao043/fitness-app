/**
 * FR-17 围度曲线的组装（`lib/chart/series.ts` 的 `measurementLines`）。
 *
 * 口径：**可叠加对比** —— 每个选中的指标各一条独立线（各有颜色），缺项的日期整点跳过
 * （不补 0、不与别的日期连线）；窗口按 days 裁，`today` 由调用方给（函数里不读时钟）。
 */

import { describe, expect, it } from "vitest";
import { MEASUREMENT_METRICS, measurementLines } from "@/lib/chart/series";

const TODAY = "2026-09-30";

const rows = [
  { date: "2026-09-01", waistCm: 85, chestCm: 100, armCm: 36, thighCm: 56 },
  { date: "2026-09-25", waistCm: 84, chestCm: null, armCm: 36, thighCm: 55 },
  { date: "2026-09-28", waistCm: 83.5, chestCm: 99, armCm: null, thighCm: 55 },
  { date: "2026-09-30", waistCm: 83, chestCm: 98.5, armCm: 35.5, thighCm: 54.5 },
];

const waist = MEASUREMENT_METRICS[0];
const arm = MEASUREMENT_METRICS[2];
const thigh = MEASUREMENT_METRICS[3];

describe("FR-17 围度曲线：单选一条线，多选叠加对比", () => {
  it("单选腰围：窗口内按日期升序、跨过窗口的那条不进图", () => {
    const lines = measurementLines(rows, [waist], 7, TODAY);
    expect(lines).toHaveLength(1);
    expect(lines[0].color).toBe("var(--accent)");
    expect(lines[0].points).toEqual([
      { date: "2026-09-25", value: 84 },
      { date: "2026-09-28", value: 83.5 },
      { date: "2026-09-30", value: 83 },
    ]);
  });

  it("多选叠加：每个指标各一条线、颜色互不相同；缺项不补 0 也不连线（臂围只有两天读数）", () => {
    const lines = measurementLines(rows, [waist, arm], 7, TODAY);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.color)).size).toBe(2);
    expect(lines[1].points).toEqual([
      { date: "2026-09-25", value: 36 },
      { date: "2026-09-30", value: 35.5 },
    ]);
  });

  it("档位换 30 天能看到 09-01 那条；窗口内没有读数的指标不出线", () => {
    const wide = measurementLines(rows, [thigh], 30, TODAY);
    expect(wide[0].points[0]).toEqual({ date: "2026-09-01", value: 56 });
    expect(measurementLines(rows, [thigh], 7, "2026-10-31")).toEqual([]);
  });
});
