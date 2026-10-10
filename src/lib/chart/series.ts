/**
 * 趋势折线图的数据组装（FR-17 / FR-27 共用）。
 *
 * 放在 `lib` 里而不是组件里，是为了能脱离 JSX 单测（排期引擎那条老规矩的同类要求）：
 * 组件只负责画，窗口裁剪与多指标叠加对比的口径在这里。
 */

import { kgToDisplay } from "@/lib/units";

export interface ChartLine {
  color: string;
  dashed?: boolean;
  /** 点按日期升序 */
  points: { date: string; value: number }[];
}

/** 围度四项（FR-15 / FR-17）：key 与接口字段同名，颜色用于叠加对比时的图例与线色 */
export const MEASUREMENT_METRICS = [
  { key: "waistCm", label: "腰围", color: "var(--accent)" },
  { key: "chestCm", label: "胸围", color: "var(--ok)" },
  { key: "armCm", label: "臂围", color: "var(--warn)" },
  { key: "thighCm", label: "腿围", color: "var(--alert)" },
] as const;

/**
 * 围度曲线（FR-17：**可叠加对比**）：每个选中的指标各一条独立线（颜色见上表），
 * 缺项的日期整点跳过（不补 0、不与别的日期连线）；`today` 由调用方给 ——
 * 函数里读时钟就没法测了。
 */
export function measurementLines<T extends { date: string }>(
  rows: readonly T[],
  metrics: readonly { key: string; color: string }[],
  days: number,
  today: string,
): ChartLine[] {
  const from = subtractDays(today, days - 1);
  return metrics
    .map((metric) => ({
      color: metric.color,
      points: rows
        .filter((row) => row.date >= from && row.date <= today)
        .map((row) => ({ date: row.date, value: (row as Record<string, unknown>)[metric.key] }))
        .filter((p): p is { date: string; value: number } => typeof p.value === "number")
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter((line) => line.points.length > 0);
}

/** 纯日历减（x 轴按真实日期间隔映射，别按数组下标均分 —— 设计说明 §13.1 的教训） */
export function subtractDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 重量趋势的折线（从记录页搬出来，issue #25）：**没有重量数据的那天不产生点**
 * （`maxWeightKg` 为 null 就跳过 —— 按 0 画会把趋势压出一条假的下降，13.1）。
 */
export function weightTrendLines(
  rows: readonly { date: string; maxWeightKg: number | null }[],
  unit: "kg" | "lb",
): ChartLine[] {
  const points = rows
    .filter((r) => r.maxWeightKg !== null && Number.isFinite(r.maxWeightKg))
    .map((r) => ({
      date: r.date,
      value: kgToDisplay(r.maxWeightKg as number, unit) ?? (r.maxWeightKg as number),
    }));
  return points.length > 0 ? [{ color: "var(--accent)", points }] : [];
}
