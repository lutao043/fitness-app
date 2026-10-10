/**
 * 目标达成日期预估（FR-16）：按**最近 14 天的晨起序列**做线性趋势外推。
 *
 * 口径（13.2）：
 * - **一律基于 morning 序列**（晨起与睡前差 1–1.5 kg，混着算等于把趋势埋掉）；
 * - 显式按日期比较（设计说明 §13.1 的教训：别用数组下标）——记录稀疏时按真实日期间隔算斜率；
 * - 放纵餐、单日水分波动都会让数字大幅跳变，所以 UI 旁必须带「按当前速率估算，仅供参考」。
 *
 * 不做任何"建议你要不要调目标"的判断 —— 工具只陈述事实（第 12 章第 1 条精神）。
 */

import { addDays, dayDiff, type DateStr } from "@/lib/time";
import { kgToDisplay, type WeightUnit } from "@/lib/units";

export const TREND_WINDOW_DAYS = 14;
/** 窗口内至少要有几个晨起点才敢外推 */
export const TREND_MIN_POINTS = 3;
/** 点至少要跨多少天，否则两天内的波动会把斜率放得离谱 */
export const TREND_MIN_SPAN_DAYS = 5;
/** 速率的绝对值低于这个数（kg/天）视为"没在动"，不外推 */
export const TREND_MIN_RATE_KG_PER_DAY = 0.01;

export interface TrendPoint {
  date: DateStr;
  weightKg: number;
}

export interface GoalEta {
  /** 窗口内日均变化（kg/天，负 = 在降）；样本不足为 null */
  perDayKg: number | null;
  /** 预估达成目标的日期；无法估算为 null */
  etaDate: DateStr | null;
  /** 距预估达成日的天数（向上取整） */
  daysLeft: number | null;
  /** 当前值相对目标的方向：down = 还要降，up = 已低于目标（增肌向），none = 已达标 */
  direction: "down" | "up" | "none";
}

/**
 * 最小二乘斜率：x = 距首日的天数，y = 体重。只用于展示层预估，不做任何判定。
 */
export function estimateGoalEta(input: {
  today: DateStr;
  targetKg: number;
  /** 晨起序列（升序或乱序均可，函数内部按日期取窗口） */
  morning: readonly TrendPoint[];
  windowDays?: number;
}): GoalEta {
  const window = input.windowDays ?? TREND_WINDOW_DAYS;
  const from = addDays(input.today, -(window - 1));
  const points = input.morning
    .filter((p) => p.date >= from && p.date <= input.today)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const none: GoalEta = { perDayKg: null, etaDate: null, daysLeft: null, direction: "none" };
  if (points.length < TREND_MIN_POINTS) return none;

  const span = dayDiff(points[0].date, points[points.length - 1].date);
  if (span < TREND_MIN_SPAN_DAYS) return none;

  // 最小二乘：x = 距第一点的天数
  const n = points.length;
  const x0 = points[0].date;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const x = dayDiff(x0, p.date);
    sx += x;
    sy += p.weightKg;
    sxx += x * x;
    sxy += x * p.weightKg;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return none;
  const perDayKg = (n * sxy - sx * sy) / denom;

  const latest = points[points.length - 1].weightKg;
  const gap = latest - input.targetKg;
  if (Math.abs(gap) < 1e-9) {
    // 已经踩在目标上：不算"预估"，直接达标
    return { perDayKg, etaDate: input.today, daysLeft: 0, direction: "none" };
  }
  const direction: GoalEta["direction"] = gap > 0 ? "down" : "up";
  // 还要降但速率不在降（或反过来）→ 不给日期，免得编一个谎言
  if (gap > 0 && perDayKg >= -TREND_MIN_RATE_KG_PER_DAY) return { perDayKg, etaDate: null, daysLeft: null, direction };
  if (gap < 0 && perDayKg <= TREND_MIN_RATE_KG_PER_DAY) return { perDayKg, etaDate: null, daysLeft: null, direction };

  // 商先舍入到 1e-6 再 ceil：0.7/0.1 = 7.0000…028，直接 ceil 会变成 8 天
  const rawDays = Math.abs(gap) / Math.abs(perDayKg);
  const daysLeft = Math.ceil(Math.round(rawDays * 1e6) / 1e6);
  // 超过一年的预估没有意义（速率早会变），宁可不显示
  if (daysLeft > 365) return { perDayKg, etaDate: null, daysLeft: null, direction };
  return { perDayKg, etaDate: addDays(input.today, daysLeft), daysLeft, direction };
}

/**
 * 预估行的展示文案（UI 直接用；含免责，FR-16 / 设计说明 §7）。
 * 计算一律按 kg（13.2 口径），这里只把要显示的重量换算成当前单位（§1.1）。
 */
export function goalEtaText(eta: GoalEta, targetKg: number, unit: WeightUnit = "kg"): string {
  const target = kgToDisplay(targetKg, unit) ?? targetKg;
  if (eta.direction === "none" && eta.daysLeft === 0) return `已在目标 ${target} ${unit} 附近`;
  if (eta.etaDate && eta.daysLeft !== null) {
    return `按当前速率约 ${eta.daysLeft} 天后（${eta.etaDate}）到 ${target} ${unit}`;
  }
  if (eta.perDayKg !== null) {
    const dir = eta.perDayKg < 0 ? "在降" : "在升";
    const rate = kgToDisplay(Math.abs(eta.perDayKg), unit) ?? 0;
    return `近 14 天${dir} ${rate} ${unit}/天，暂不外推达成日`;
  }
  return "晨起记录还不够，先记满一两周";
}
