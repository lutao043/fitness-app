/**
 * 时间与日期工具（需求书 NFR-7 / 第 9 章第 4 条 / 13.3）。
 *
 * 约定：
 * - 内部一切"自然日"都用 `DateStr = "YYYY-MM-DD"`（定长、可比较、可做字符串区间判断），
 *   它代表 **Asia/Shanghai** 的那一天；时刻一律用 `HH:mm`。
 * - "现在是什么日期/几点"必须走时区转换（date-fns-tz），**不要用裸 Date 的本地时间**。
 * - 纯日历加减（±N 天、星期几）用 UTC 表示做算术：它只处理年月日，与宿主时区、夏令时无关
 *   （中国无夏令时，但我们也不依赖这一点）。这样 `addDays`/`dayDiff` 在任何机器上都一致。
 */

import { formatInTimeZone } from "date-fns-tz";

export type DateStr = string; // YYYY-MM-DD
export type TimeStr = string; // HH:mm

export const TZ = "Asia/Shanghai";

export const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function isValidDateStr(value: unknown): value is DateStr {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = calendarDate(value);
  return formatCalendar(d) === value; // 挡掉 2026-02-30 这类"格式对但日子不存在"
}

export function isValidTimeStr(value: unknown): value is TimeStr {
  if (typeof value !== "string" || !TIME_RE.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** 把 DateStr 解析成"只表示年月日"的 Date（UTC 表示，仅供纯日历运算）。 */
export function calendarDate(date: DateStr): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function formatCalendar(d: Date): DateStr {
  return d.toISOString().slice(0, 10);
}

/** 某个时刻在 Asia/Shanghai 下的自然日。 */
export function dateInTz(instant: Date = new Date()): DateStr {
  return formatInTimeZone(instant, TZ, "yyyy-MM-dd");
}

/** 某个时刻在 Asia/Shanghai 下的 HH:mm。 */
export function timeInTz(instant: Date = new Date()): TimeStr {
  return formatInTimeZone(instant, TZ, "HH:mm");
}

/** 跨零点归属（13.3）：会话 / 打卡都按"开始时刻所在自然日"。 */
export function attributionDateInTz(instant: Date): DateStr {
  return dateInTz(instant);
}

export function addDays(date: DateStr, days: number): DateStr {
  const d = calendarDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatCalendar(d);
}

/** b - a 的整数天数（纯日历差，忽略时区）。 */
export function dayDiff(a: DateStr, b: DateStr): number {
  return Math.round((calendarDate(b).getTime() - calendarDate(a).getTime()) / 86_400_000);
}

export function weekdayIndex(date: DateStr): number {
  return calendarDate(date).getUTCDay(); // 0=周日
}

export function weekdayCn(date: DateStr): string {
  return WEEKDAY_CN[weekdayIndex(date)] ?? "";
}

export function isWeekend(date: DateStr): boolean {
  const w = weekdayIndex(date);
  return w === 0 || w === 6;
}

/** 「9月25日 周五」（NFR-7：日期中文化）。 */
export function formatCn(date: DateStr): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}月${d}日 ${weekdayCn(date)}`;
}

export function formatCnLong(date: DateStr): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}年${m}月${d}日 ${weekdayCn(date)}`;
}

export function hhmmToMinutes(time: TimeStr): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToHhmm(minutes: number): TimeStr {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 凌晨 0 点前的分钟数：加班跨零点（23:00 开始）按开始时间判定（13.11）。 */
export function minutesSinceMidnight(time: TimeStr): number {
  return hhmmToMinutes(time);
}

/**
 * 两个日期之间差几天（非负；同日 0）。**从今日页搬出来**（issue #25：
 * 页面里的纯函数写在组件文件里天生不可测）。
 */
export function daysUntil(from: DateStr | string, to: DateStr | string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** 「10月12日」（加练顺延提示用；只说近处，不写年份） */
export function monthDay(date: DateStr | string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/** 「今天 · 9月29日 周二」，其他日期只给日期（原型规则）。`today` 由调用方传，便于单测 */
export function dayLabel(date: DateStr | string, today: DateStr | string): string {
  return date === today ? `今天 · ${formatCn(date as DateStr)}` : formatCn(date as DateStr);
}

/** 「2026 年 9 月」（记录页按月分隔） */
export function monthLabel(date: DateStr | string): string {
  const [y, m] = date.split("-");
  return `${y} 年 ${Number(m)} 月`;
}
