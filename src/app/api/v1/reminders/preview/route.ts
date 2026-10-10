/**
 * GET /api/v1/reminders/preview?at=HH:mm&date=YYYY-MM-DD —— 提醒判定演练（FR-55，**只读**）。
 *
 * 把"判定时刻"拨到任意 HH:mm，按 13.10 的判定表跑一遍，把每条判定链的命中情况、
 * 训练提醒的结论（发不发、发什么、一键动作）与每种补剂的到点情况都吐出来，
 * 用来和设备实际行为对拍（10.1 并行期）。
 *
 * **不生成事件、不写去重与投递记录** —— 演练不能把当天的真投递顶掉（原型那个演练面板会写，
 * 正式版明确不写；要发真提醒等定时 tick 或调 `reminders/due`）。
 */

import { getDb } from "@/db/client";
import { loadScheduleState, reminderTime, supplementsFor, todayFacts } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json } from "@/server/http";
import { buildReminderInput } from "@/server/reminders";
import { decideReminder } from "@/lib/reminder/decide";
import { decideSupplement } from "@/lib/reminder/supplements";
import { dateInTz, isValidDateStr, isValidTimeStr } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  const url = new URL(request.url);

  const date = url.searchParams.get("date") ?? dateInTz();
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);
  if (date > dateInTz()) return badRequest("date 不能是未来的日子", undefined, request);

  // 演练时刻：没给就用配置的提醒时间（"到点会怎样"）
  const checkTime = reminderTime(db);
  const rawAt = url.searchParams.get("at") ?? "";
  if (rawAt !== "" && !isValidTimeStr(rawAt)) return badRequest("at 必须是 HH:mm", undefined, request);
  const at = rawAt || checkTime;

  const nowTs = Date.parse(`${date}T${at}:00+08:00`);
  const input = buildReminderInput(db, {
    state: loadScheduleState(db, date),
    facts: todayFacts(db, date),
    today: date,
    at,
    nowTs: Number.isFinite(nowTs) ? nowTs : Date.now(),
  });
  const decision = decideReminder(input);

  const supplements = supplementsFor(db, date).map((s) => ({
    id: s.id,
    name: s.name,
    doseText: s.doseText,
    times: s.times,
    takenToday: s.takenToday,
    verdict: decideSupplement({
      supplementId: s.id,
      name: s.name,
      times: s.times,
      takenToday: s.takenToday,
      // 演练只看"到点该不该提"；真实去重交给定时 tick（这里当还没生成过）
      eventAlreadyGenerated: false,
      at,
    }),
  }));

  return json({
    date,
    at,
    /** 配置的提醒时间：判定时刻早于它 → 结论里会标注"还没到判定时刻" */
    checkTime,
    decision,
    /** 判定输入（页面自检用：为什么是这个结论，看这里） */
    input,
    supplements,
    /** 明确声明：演练不落任何记录 */
    sideEffects: { eventsWritten: 0, deliveriesWritten: 0 },
  });
}
