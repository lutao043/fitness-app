/**
 * POST /api/v1/sessions —— 新建本次训练（需求书第 7 章）。
 *
 * 幂等：请求体带 `client_id`，重复提交返回既有会话而不是新建（离线队列重试安全）。
 * `date` 缺省 = `started_at` 所在自然日（13.3：跨零点归属开始那天）。
 *
 * GET /api/v1/sessions —— 训练历史列表（记录页；含「已打卡 · 无明细」行，13.4）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { historyRows, loadScheduleState, sessionsOn } from "@/db/queries";
import { applyExtraTrainingShift, createSession, ensureCheckin } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { asBool, asNumber, asString, badRequest, json, oneOf, readJsonBody, writeJson } from "@/server/http";
import { normalizeSummary, refreshSessionSummary } from "@/server/session";
import { dateInTz, isValidDateStr } from "@/lib/time";
import { isTrainingDay } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (date) {
    if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);
    return json({ date, sessions: sessionsOn(db, date) });
  }

  const limitParam = Number(url.searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(limitParam) ? Math.min(200, Math.max(1, limitParam)) : 60;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if (from && !isValidDateStr(from)) return badRequest("from 不是合法日期", undefined, request);
  if (to && !isValidDateStr(to)) return badRequest("to 不是合法日期", undefined, request);

  return json({ rows: historyRows(db, { from, to, limit }) });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const clientId = asString(body.client_id ?? body.clientId);
  if (!clientId) return badRequest("缺少 client_id（幂等键）", undefined, request);

  const startedAt = asString(body.started_at ?? body.startedAt) ?? null;
  const date =
    asString(body.date) ??
    (startedAt && Number.isFinite(Date.parse(startedAt)) ? dateInTz(new Date(startedAt)) : dateInTz());
  if (!isValidDateStr(date)) return badRequest("date 不是合法日期（YYYY-MM-DD）", undefined, request);

  const status = oneOf(body.status, ["planned", "doing", "done", "aborted"] as const) ?? "doing";
  const part = asString(body.part) ?? "";
  if (!part) return badRequest("缺少 part（今天练的部位）", undefined, request);
  const mode = oneOf(body.mode, ["gym", "home"] as const) ?? "gym";
  const templateId = asNumber(body.template_id ?? body.templateId) ?? null;
  const restTargetSec = asNumber(body.rest_target_sec ?? body.restTargetSec) ?? 90;

  // 加练（13.17）：只有"今天 + 非训练日（循环位「休」/ 假期）+ 当前方案的非休槽位"才算加练，
  // 其余一律 400 —— 训练日开练走普通路径（FR-4 的改练不写位点），补录也不能是加练。
  const extra = asBool(body.extra) ?? false;
  if (extra) {
    const today = dateInTz();
    const state = loadScheduleState(getDb(), today);
    const slot = state.slots.find((s) => s.templateId === templateId) ?? null;
    if (date !== today) return badRequest("加练只能记今天（13.17）", undefined, request);
    if (status === "done" || status === "aborted") {
      return badRequest("加练要当场开练：不能补录、不能直接置 done/aborted", undefined, request);
    }
    if (!slot || slot.rest) return badRequest("加练要选当前方案里的非休槽位", undefined, request);
    if (isTrainingDay(date, state.ctx, state.slots)) {
      return badRequest("今天是训练日：直接开练就行（加练只用在休息日 / 假期）", undefined, request);
    }
  }

  const rawExercises = Array.isArray(body.exercises) ? body.exercises : [];
  const exercises = rawExercises.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    return {
      exerciseId: asNumber(item.exercise_id ?? item.exerciseId) ?? 0,
      orderNo: asNumber(item.order_no ?? item.orderNo) ?? index,
      targetSets: asNumber(item.target_sets ?? item.targetSets) ?? 4,
      targetReps: asNumber(item.target_reps ?? item.targetReps) ?? 12,
    };
  });
  if (exercises.some((e) => !e.exerciseId)) return badRequest("exercises[].exercise_id 无效", undefined, request);

  const result = createSession(getDb(), {
    clientId,
    date,
    part,
    mode,
    status,
    templateId,
    // 补录（status=done 且没带 started_at）：不编开始时间 —— 时长算 0 比编一个假时刻诚实
    startedAt: startedAt ?? (status === "done" ? null : new Date().toISOString()),
    restTargetSec,
    planSnapshot: body.plan_snapshot ?? body.planSnapshot ?? null,
    isExtra: extra,
    exercises,
  });

  // 加练开练即生效（13.17）：写循环位点（今天没休的「休」顺延到明天 + 部位的下一次排期去掉）。
  // 幂等：位点按 ref_session_id 只写一次，重复提交（client_id 命中）不会写第二条。
  if (extra && result.created && status === "doing") {
    applyExtraTrainingShift(getDb(), { sessionId: result.id, date, templateId });
  }

  // 补录即收工（FR-13）：建场就把小结算好落库、顺手打卡 —— 记录页那一行立刻是完整的一行
  if (status === "done" && result.created) {
    refreshSessionSummary(getDb(), result.id);
    ensureCheckin(getDb(), { date, kind: "workout", source: "web" });
  }

  return writeJson(request, 
    { id: result.id, created: result.created, date, status, extra, summary: sessionSummaryOf(result.id) },
    { status: result.created ? 201 : 200 },
  );
}

/** 只读一下刚写的小结（补录路径用；查不到就给 null）。存量行按新口径补齐时长（v1.34） */
function sessionSummaryOf(sessionId: number) {
  const row = getDb()
    .select({
      summary: schema.workoutSession.summary,
      startedAt: schema.workoutSession.startedAt,
      endedAt: schema.workoutSession.endedAt,
    })
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  return normalizeSummary(row?.summary, row) ?? null;
}
