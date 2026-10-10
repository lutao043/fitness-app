/**
 * POST /api/v1/sessions/{id}/sets —— 记一组（FR-7 / FR-9 / FR-48）
 *
 * 组间歇、same_exercise、容量折算都在服务端算（见 server/session.ts），
 * 客户端只负责上报「完成了一组」，重放由 client_key 兜住。
 * （单组的改 / 删在 `sets/[setId]` 下，见那里的注释。）
 *
 * 热身组已取消（v1.26，FR-53 改写为「练前提示」）：`is_warmup: true` 一律 400，不再记录热身组。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { parseSetBody } from "@/server/rules";
import { badRequest, notFound, readJsonBody, writeJson } from "@/server/http";
import { refreshSessionSummary, writeSet } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const db = getDb();
  const session = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  if (!session) return notFound("会话不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // 读数范围（13.1，0 合法）/ feel 枚举 / is_warmup 拒绝 / client_key 兜底都收敛在
  // server/rules.ts（13.19 的范围表与那里的常量逐项对齐）
  const set = parseSetBody(parsed.body, {
    defaultClientKey: `${session.clientId}:${crypto.randomUUID()}`,
    defaultDoneAt: new Date().toISOString(),
  });
  if (!set.ok) return badRequest(set.issues.join("；"), undefined, request);

  const result = writeSet(db, sessionId, { ...set.value });
  if ("error" in result) return badRequest(result.error, undefined, request);

  // 每次写组都把小结重算落库（FR-13 v1.18）：补录 / 改历史后，记录页与今日页的
  // 组数容量立刻是对的，不会等到下次收工才刷新
  refreshSessionSummary(db, sessionId);

  return writeJson(request, result, { status: result.created ? 201 : 200 });
}
