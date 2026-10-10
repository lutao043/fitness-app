/**
 * POST /api/v1/reminders/{id}/sent —— 标记事件已投递（第 7 章）。
 *
 * `{channel: "feishu"|"pwa", status?: "sent"|"dry_run"}`；同一 (事件, 渠道) 重复标记 = no-op。
 * dry_run → sent 的升级是 10.1 的切换动作（试运行期记 dry_run，切换后真实投递完标 sent）；
 * 只升不降：已 sent 的不会再变回 dry_run。
 */

import { getDb } from "@/db/client";
import { requireApiAuth } from "@/server/auth";
import { badRequest, notFound, oneOf, readJsonBody, writeJson } from "@/server/http";
import { markDelivery } from "@/db/writes";
import { isReminderChannel } from "@/lib/reminder";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("事件 id 不合法", undefined, request);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const rawChannel = body.channel ?? "feishu";
  if (!isReminderChannel(rawChannel)) return badRequest('channel 只能是 "feishu" 或 "pwa"', undefined, request);
  const status = oneOf(body.status, ["sent", "dry_run"] as const) ?? "sent";

  const db = getDb();
  const event = db
    .select({ id: schema.reminderEvent.id })
    .from(schema.reminderEvent)
    .where(eq(schema.reminderEvent.id, id))
    .get();
  if (!event) return notFound("事件不存在");

  const res = markDelivery(db, { eventId: id, channel: rawChannel, status });
  return writeJson(request, { event_id: id, channel: rawChannel, status, created: res.created, upgraded: res.upgraded });
}
