/**
 * GET /api/v1/reminders/due —— 现在该发哪些提醒（FR-39，助手轮询用）。
 *
 * - 先跑一次提醒滴答（与定时任务同一份实现）：到点的事件当场生成，所以助手轮询自愈于定时任务停摆；
 * - **按渠道过滤**（第 7 章）：只返回该渠道尚无 `status=sent` 投递记录的事件，
 *   `dry_run` 是并行试运行期的记账（10.1），不算真实投递；
 * - 投递前把 13.10 的判定**再跑一遍**：生成之后他又练了/打了卡，这条就不再返回（练了就闭嘴）；
 * - 助手侧零逻辑：每条事件自带 title/body/action 与一键动作的请求参数（FR-30），
 *   投完调 `POST /api/v1/reminders/{id}/sent` 记账。
 */

import { getDb } from "@/db/client";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json } from "@/server/http";
import { dueReminders } from "@/server/reminders";
import { isReminderChannel } from "@/lib/reminder";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const rawChannel = url.searchParams.get("channel") ?? "feishu";
  if (!isReminderChannel(rawChannel)) return badRequest('channel 只能是 "feishu" 或 "pwa"', undefined, request);

  const payload = dueReminders(getDb(), Date.now(), rawChannel);
  return json(payload);
}
