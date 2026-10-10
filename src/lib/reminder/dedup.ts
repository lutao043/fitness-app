/**
 * 提醒事件与投递的去重（需求书 FR-36 / FR-37 / 13.10 的两层去重）。
 *
 * - **事件**：按 `(type, ref_key, date)` 全天只生成一次；
 * - **投递**：按 `(事件, channel)` 每渠道各记一次 —— 外部渠道与 PWA 是同一条事件的两条投递记录，
 *   内容可不同，互不替代，也不互相触发（别做成两条独立事件，也别把"共用事件"实现成"只投一个渠道"）。
 *
 * ref_key 约定（需求书第 6 章）：
 *   workout → "workout"；supplement → "supp:<补剂id>"；cheat → "cheat"；
 *   reanchor → "proposal:<anchor_proposal.id>"；holiday_gap → "coverage:<覆盖期末日>"
 */

import type { DateStr } from "@/lib/time";

export type ReminderEventType =
  | "workout"
  | "supplement"
  | "cheat"
  | "reanchor"
  | "holiday_gap";

export type ReminderChannel = "feishu" | "pwa";

export const REMINDER_CHANNELS: ReminderChannel[] = ["feishu", "pwa"];

/** 事件去重键（全天唯一） */
export function eventDedupeKey(
  type: ReminderEventType,
  refKey: string,
  date: DateStr,
): string {
  return `${type}|${refKey}|${date}`;
}

/** 投递去重键（每渠道各一条） */
export function deliveryDedupeKey(
  type: ReminderEventType,
  refKey: string,
  date: DateStr,
  channel: ReminderChannel,
): string {
  return `${eventDedupeKey(type, refKey, date)}|${channel}`;
}

export function cheatRefKey(): string {
  return "cheat";
}

export function reanchorRefKey(proposalId: string | number): string {
  return `proposal:${proposalId}`;
}

export function isReminderChannel(value: unknown): value is ReminderChannel {
  return value === "feishu" || value === "pwa";
}
