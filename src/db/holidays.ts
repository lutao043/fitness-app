/**
 * 假期表写入（需求书 FR-24 / 13.12 / 第 7 章）。
 *
 * **唯一写入方是助手**（网页不提供手工编辑入口）：
 * - 整年**原子覆盖**（先按年份删干净再插，不留半张表）；
 * - **幂等**（重复写同一份结果一致）；
 * - 写入前**校验**：日期格式合法且都在 `{year}` 年内、`type ∈ {holiday, workday}`、
 *   同一天不出现两条（官方一年只公布约 30 条，不要求也不校验全年每天都有记录）；
 *   校验不通过**整单拒绝**并返回原因，库里仍是写入前的表；
 * - 写入记 `updated_at` 与 `source`（设置页展示"假期表更新于 X"）。
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";
import { isValidDateStr, type DateStr } from "@/lib/time";

export type HolidayType = "holiday" | "workday";

/** 写入元信息落 `app_meta` 的两个键（设置页「最近更新于 X · 来源 Y」读它们） */
export const HOLIDAY_META_UPDATED_AT_KEY = "holidays.updated_at";
export const HOLIDAY_META_SOURCE_KEY = "holidays.source";

export interface HolidayDayInput {
  date: DateStr;
  name: string;
  type: HolidayType;
}

export class HolidayValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "HolidayValidationError";
  }
}

export interface HolidayWriteResult {
  year: number;
  written: number;
  replaced: number;
  updatedAt: string;
  source: string;
}

export function validateHolidayPayload(payload: unknown): { year: number; days: HolidayDayInput[] } {
  if (typeof payload !== "object" || payload === null) {
    throw new HolidayValidationError("请求体必须是 JSON 对象", ["请求体不是对象"]);
  }
  const body = payload as { year?: unknown; days?: unknown; source?: unknown };
  const year = Number(body.year);
  const issues: string[] = [];
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    issues.push("year 必须是 2000~2100 之间的整数");
  }
  if (!Array.isArray(body.days)) {
    issues.push("days 必须是数组");
    throw new HolidayValidationError("假期表校验不通过", issues);
  }

  const seen = new Set<string>();
  const days: HolidayDayInput[] = [];
  body.days.forEach((raw, index) => {
    const item = raw as { date?: unknown; name?: unknown; type?: unknown };
    const where = `days[${index}]`;
    const date = typeof item.date === "string" ? item.date : "";
    if (!isValidDateStr(date)) {
      issues.push(`${where}.date 不是合法日期：${String(item.date)}`);
      return;
    }
    if (year && !date.startsWith(`${year}-`)) {
      issues.push(`${where}.date 不在 ${year} 年内：${date}`);
    }
    if (item.type !== "holiday" && item.type !== "workday") {
      issues.push(`${where}.type 只能是 holiday 或 workday：${String(item.type)}`);
    }
    if (typeof item.name !== "string" || item.name.trim() === "") {
      issues.push(`${where}.name 不能为空`);
    }
    if (seen.has(date)) {
      issues.push(`同一天出现两条记录：${date}`);
    }
    seen.add(date);
    days.push({ date, name: String(item.name ?? "").trim(), type: item.type as HolidayType });
  });

  if (issues.length > 0) throw new HolidayValidationError("假期表校验不通过", issues);
  return { year, days };
}

/** 整年原子覆盖：删该年份 + 插入新表，同一个事务里完成 */
export function replaceHolidayYear(
  db: Db,
  payload: unknown,
  opts: { source?: string; now?: Date } = {},
): HolidayWriteResult {
  const { year, days } = validateHolidayPayload(payload);
  const source = typeof opts.source === "string" && opts.source ? opts.source : "assistant";
  const updatedAt = (opts.now ?? new Date()).toISOString();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  return db.transaction((tx) => {
    const replaced = tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.holiday)
      .where(and(gte(schema.holiday.date, from), lte(schema.holiday.date, to)))
      .get();
    tx.delete(schema.holiday)
      .where(and(gte(schema.holiday.date, from), lte(schema.holiday.date, to)))
      .run();
    for (const day of days) {
      tx.insert(schema.holiday)
        .values({ date: day.date, name: day.name, type: day.type, updatedAt, source })
        .run();
    }
    tx.insert(schema.appMeta)
      .values({ key: HOLIDAY_META_UPDATED_AT_KEY, value: updatedAt })
      .onConflictDoUpdate({ target: schema.appMeta.key, set: { value: updatedAt } })
      .run();
    tx.insert(schema.appMeta)
      .values({ key: HOLIDAY_META_SOURCE_KEY, value: source })
      .onConflictDoUpdate({ target: schema.appMeta.key, set: { value: source } })
      .run();
    return {
      year,
      written: days.length,
      replaced: Number(replaced?.n ?? 0),
      updatedAt,
      source,
    };
  });
}

export function holidaysInYear(db: Db, year: number) {
  return db
    .select()
    .from(schema.holiday)
    .where(and(gte(schema.holiday.date, `${year}-01-01`), lte(schema.holiday.date, `${year}-12-31`)))
    .orderBy(schema.holiday.date)
    .all();
}

export function holidayWriteMeta(db: Db): { updatedAt: string | null; source: string | null } {
  const rows = db.select().from(schema.appMeta).all();
  const updatedAt = rows.find((r) => r.key === HOLIDAY_META_UPDATED_AT_KEY)?.value ?? null;
  const source = rows.find((r) => r.key === HOLIDAY_META_SOURCE_KEY)?.value ?? null;
  return { updatedAt, source };
}

/**
 * 覆盖期自检的"已处理"时间（13.12）：
 * 同一覆盖期版本的事件生成日期 + 助手回执（查了但官方还没发布）都算一次处理。
 */
export function holidayGapHandledAt(db: Db, refKey: string): DateStr | null {
  const events = db
    .select({ date: schema.reminderEvent.date })
    .from(schema.reminderEvent)
    .where(and(eq(schema.reminderEvent.type, "holiday_gap"), eq(schema.reminderEvent.refKey, refKey)))
    .all();
  const check = db.select().from(schema.appMeta).all().find((r) => r.key === "holiday_check");
  const dates = events.map((e) => e.date);
  if (check?.value) {
    const parsed = JSON.parse(check.value) as { ref?: string; at?: string };
    if (parsed.ref === refKey && parsed.at) dates.push(parsed.at);
  }
  if (dates.length === 0) return null;
  return dates.sort().at(-1) ?? null;
}

/** 助手"查了，官方还没发布"的回执（计入 30 天冷却） */
export function recordHolidayCheck(db: Db, refKey: string, at: DateStr): void {
  const value = JSON.stringify({ ref: refKey, at });
  db.insert(schema.appMeta)
    .values({ key: "holiday_check", value })
    .onConflictDoUpdate({ target: schema.appMeta.key, set: { value } })
    .run();
}
