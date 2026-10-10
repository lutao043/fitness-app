/**
 * GET    /api/v1/sessions/{id} —— 单次详情（组明细 + 小结，FR-13 / FR-43）
 * PATCH  /api/v1/sessions/{id} —— 补记录 / 标记完成 / 改部位（需求书第 7 章）。
 * DELETE /api/v1/sessions/{id} —— 删除会话（planning 超时退回 idle 时用，4.2）。
 *
 * 幂等：PATCH 只按传入字段更新；重复提交同一份结果一致；标记 done 时重算小结（FR-43）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { latestSetByExerciseVariant, sessionDetail, settingsMap } from "@/db/queries";
import {
  deleteSession,
  applyExtraTrainingShift,
  ensureCheckin,
  revokeCheckin,
  revertExtraTrainingShift,
  updateSession,
} from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { parseSessionPatchBody } from "@/server/rules";
import { badRequest, json, notFound, readJsonBody, writeJson } from "@/server/http";
import { computeSessionSummary, normalizeSummary, sessionCompletionOf } from "@/server/session";
import { asWeightUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const detail = sessionDetail(getDb(), sessionId);
  if (!detail) return notFound("会话不存在");

  // 「照上次填」（FR-7）：按「动作 × 变体」给本次的每个动作带上最近一组
  const history = latestSetByExerciseVariant(getDb());
  const prefill: Record<string, Record<string, unknown>> = {};
  for (const ex of detail.sessionExercises) {
    const byVariant = history.get(ex.exerciseId);
    if (!byVariant) continue;
    prefill[String(ex.exerciseId)] = Object.fromEntries(
      Array.from(byVariant.entries()).map(([key, last]) => [
        key,
        {
          weightKg: last.weightKg,
          reps: last.reps,
          durationSec: last.durationSec,
          doneAt: last.doneAt,
        },
      ]),
    );
  }

  return json({
    session: detail.session,
    exercises: detail.sessionExercises,
    sets: detail.sets,
    summary:
      normalizeSummary(detail.session.summary, detail.session) ?? computeSessionSummary(getDb(), sessionId),
    // 完成度（issue #45）：主标 = 已记组数 / 目标之和，副标分母只算记过组的动作（僵尸行不算）
    completion: sessionCompletionOf(getDb(), sessionId),
    prefill,
    // 展示单位（§1.1）：组值 / 预填 / 容量都按它换算，库里始终 kg
    unit: asWeightUnit(settingsMap(getDb()).unit),
  });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const db = getDb();
  const existing = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  if (!existing) return notFound("会话不存在");

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // 枚举类字段（status / mode / feel）非法值一律 400（issue #14 第 4 条：不静默当"没传"）；
  // 其余字段的解析与校验收敛在 server/rules.ts
  const patch = parseSessionPatchBody(parsed.body);
  if (!patch.ok) return badRequest(patch.issues.join("；"), undefined, request);
  const body = patch.value;

  const status = body.status;
  if (status && status !== existing.status && status !== "planned") {
    if (status === "done" || status === "doing") {
      // 会话的 date 归 started_at 那天（13.3），这里再兜一次底
      if (!existing.startedAt) {
        updateSession(db, sessionId, { startedAt: new Date().toISOString() });
      }
    }
    // 加练开练（13.17）：planned → doing 时写循环位点；幂等（位点按 ref_session_id 只写一次）
    if (status === "doing" && existing.isExtra && existing.status !== "doing") {
      applyExtraTrainingShift(db, { sessionId, date: existing.date, templateId: existing.templateId });
    }
    // 置 aborted = 不算练完（13.4）：把**由这场会话派生的**两样东西一起撤（issue #15）——
    // 加练的循环位点（13.17）+ 收工时自动写的那条 workout 打卡（按 ref_id = 会话 id 精确撤销，
    // 不误伤用户手点的「一键打卡」或另一场会话的打卡；否则出勤率会一直挂着一个不存在的"练过了"）。
    if (status === "aborted" && existing.status !== "aborted") {
      if (existing.isExtra) revertExtraTrainingShift(db, sessionId);
      revokeCheckin(db, { date: existing.date, kind: "workout", refId: sessionId });
    }
  }

  const endedAt = body.endedAt;

  updateSession(db, sessionId, {
    status,
    part: body.part,
    mode: body.mode,
    startedAt: body.startedAt,
    endedAt,
    pausedSec: body.pausedSec,
    restTargetSec: body.restTargetSec,
    planSnapshot: body.planSnapshot,
    feel: body.feel === undefined ? null : body.feel,
    note: body.note === undefined ? null : body.note,
  });

  // 完成 / 提前结束 → 当天算练完：自动打卡 + 写小结（FR-12 / FR-43）
  if (status === "done") {
    const finalEndedAt = endedAt ?? new Date().toISOString();
    if (existing.status !== "done") {
      updateSession(db, sessionId, { endedAt: finalEndedAt });
    }
    const summary = computeSessionSummary(db, sessionId);
    updateSession(db, sessionId, { summary });
    // 派生物的来源写清楚（issue #15 / v1.33）：这条打卡带 `ref_id = 会话 id`，
    // 会话置 aborted 时才撤得掉、也撤得准（用户手点的打卡 ref_id 为空，不受影响）
    ensureCheckin(db, { date: existing.date, kind: "workout", refId: sessionId, source: "web" });
    return writeJson(request, { id: sessionId, status: "done", summary });
  }

  const updated = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  return writeJson(request, { id: sessionId, status: updated?.status, summary: normalizeSummary(updated?.summary, updated) });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const sessionId = Number(id);
  if (!Number.isInteger(sessionId)) return badRequest("会话 id 不合法", undefined, request);

  const db = getDb();
  const existing = db
    .select()
    .from(schema.workoutSession)
    .where(eq(schema.workoutSession.id, sessionId))
    .get();
  if (!existing) return notFound("会话不存在");
  // planned 会话（从未开始训练）删掉；doing/done 不允许直接删（要靠状态机收尾）
  if (existing.status !== "planned" && existing.status !== "aborted") {
    return badRequest("只有 planned / aborted 的会话可以删除", undefined, request);
  }
  // 加练的循环位点一起撤（13.17）：会话没了，排期回原样
  revertExtraTrainingShift(db, sessionId);
  deleteSession(db, sessionId);
  // planned 会话从未开始训练，也就没写过打卡，不需要清理别的表
  return writeJson(request, { id: sessionId, removed: true }, undefined, {
    // 删除类记 **before 值**（issue #40 验收 3）
    change: { id: sessionId, removed: true, date: existing.date, part: existing.part, status: existing.status },
  });
}
