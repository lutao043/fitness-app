/**
 * GET /api/v1/today —— 今天（需求书第 7 章）。
 * 返回：{date, weekday, holiday, part, exercises[], overtime, cheat, recovery[], …}
 *
 * 可选 ?date=YYYY-MM-DD（不得晚于今天）：按那天的排期给数据 —— 补记（FR-13）用它取
 * 「那天该练什么」。提醒预告 / streak / 回执等字段在指定日期下只作参考，补记流程不用它们。
 *
 * 可选 ?part=<槽位 id>：改练其他部位（FR-4）—— 今天的清单换成那个槽位，
 * **只影响今天这一次**：锚点、循环推进、欠账、streak 全按原排期算（不重锚循环）。
 */

import { getDb } from "@/db/client";
import { loadScheduleState } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json } from "@/server/http";
import { buildToday } from "@/server/today";
import { asString, oneOf } from "@/server/http";
import { dateInTz, isValidDateStr } from "@/lib/time";

export const dynamic = "force-dynamic";

/** 解析 ?part=：必须是当前方案里的**非休**槽位（休日没有清单可练） */
function parsePartOverride(request: Request, url: URL, date: string): { ok: true; id: number | null } | { ok: false; response: Response } {
  const raw = url.searchParams.get("part");
  if (raw === null || raw === "") return { ok: true, id: null };
  const id = Number(raw);
  if (!Number.isInteger(id)) return { ok: false, response: badRequest("part 必须是槽位 id（整数）", undefined, request) };
  const state = loadScheduleState(getDb(), date);
  const slot = state.slots.find((s) => s.templateId === id && !s.rest);
  if (!slot) return { ok: false, response: badRequest("part 必须是当前方案里的非休槽位", undefined, request) };
  return { ok: true, id };
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const mode = oneOf(url.searchParams.get("mode"), ["gym", "home"] as const) ?? "gym";
  const at = asString(url.searchParams.get("at") ?? undefined);

  const date = url.searchParams.get("date");
  if (date === null) {
    const part = parsePartOverride(request, url, dateInTz());
    if (!part.ok) return part.response;
    return json(buildToday(getDb(), mode, new Date(), at, part.id));
  }
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);
  if (date > dateInTz()) return badRequest("date 不能是未来的日子（还没到的排期不算补记）", undefined, request);

  const part = parsePartOverride(request, url, date);
  if (!part.ok) return part.response;

  // 正午当作那天的"现在"：避免 00:00 边界把回执/提醒预告算到前一天
  return json(buildToday(getDb(), mode, new Date(`${date}T12:00:00+08:00`), at, part.id));
}
