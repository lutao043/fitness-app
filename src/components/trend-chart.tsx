"use client";

/**
 * 趋势折线图（FR-17 / FR-27 共用）：手写内联 SVG，不引第三方图表库（NFR-9）。
 *
 * x 轴显式按日期映射（真实时间间隔，别按数组下标均分 —— 设计说明 §13.1 的教训）；
 * 多条线各自独立连线，互不相连（13.2：晨起与睡前不混线）。
 * 线的组装（窗口裁剪 / 围度叠加）在 `@/lib/chart/series`，那边是纯函数、能单测。
 */

import { subtractDays, type ChartLine } from "@/lib/chart/series";

export type { ChartLine };

export function TrendChart({
  today,
  days,
  unit,
  lines,
}: {
  today: string;
  days: number;
  unit: string;
  lines: ChartLine[];
}) {
  const W = 320;
  const H = 150;
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const span = Math.max(1, days - 1);
  const from = subtractDays(today, span);

  const all = lines.flatMap((l) => l.points);
  if (all.length === 0) {
    return <div className="muted grid h-32 place-items-center text-[12.5px]">这个窗口内还没有记录</div>;
  }
  const values = all.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(0.4, (rawMax - rawMin) * 0.15);
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;
  const xOf = (date: string) => padL + (dayDiff(from, date) / span) * innerW;
  const yOf = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const pathOf = (points: { date: string; value: number }[]) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");

  const ticks = [yMax, (yMax + yMin) / 2, yMin];
  const latest = all.reduce((a, b) => (a.date > b.date ? a : b));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`近 ${days} 天趋势图`}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)} stroke="var(--border)" strokeWidth="0.5" />
          <text x={padL - 4} y={yOf(t) + 3} textAnchor="end" fontSize="8.5" fill="var(--muted)">
            {Math.round(t * 10) / 10}
          </text>
        </g>
      ))}
      {lines.map((l, i) => (
        <g key={i}>
          {l.points.length > 1 && (
            <path
              d={pathOf(l.points)}
              fill="none"
              stroke={l.color}
              strokeWidth="1.8"
              strokeDasharray={l.dashed ? "3 3" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={l.dashed ? 0.55 : 1}
            />
          )}
          {l.points.map((p) => (
            <circle key={p.date} cx={xOf(p.date)} cy={yOf(p.value)} r="2.2" fill={l.color} opacity={l.dashed ? 0.55 : 1} />
          ))}
        </g>
      ))}
      <text
        x={xOf(latest.date)}
        y={yOf(latest.value) - 6}
        textAnchor="middle"
        fontSize="9"
        fill="var(--accent)"
        fontWeight="600"
      >
        {latest.value}
        {unit}
      </text>
      <text x={padL} y={H - 5} fontSize="8.5" fill="var(--muted)">
        {from.slice(5).replace("-", "/")}
      </text>
      <text x={W - padR} y={H - 5} textAnchor="end" fontSize="8.5" fill="var(--muted)">
        {today.slice(5).replace("-", "/")}
      </text>
    </svg>
  );
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
