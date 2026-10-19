/**
 * GET   /api/v1/settings —— 读设置（单位 / 提醒时间两档（工作日 + 休息日）与总开关 / 组间歇默认值 /
 *                            假期表元信息 / 当前方案（含槽位与锚点）/ 放纵餐设置）
 * PATCH /api/v1/settings —— 改设置（改完立即生效，FR-40：无需重启）
 *
 * 假期表**没有**写入口（FR-24 / 13.12：唯一写入方是助手）。这里只回状态。
 * 方案的增删改在 /api/v1/schemes（v1.2 规则管理），这里只回"当前用的那套"。
 */

import { getDb } from "@/db/client";
import { cheatSettingView, loadScheduleState, settingsMap } from "@/db/queries";
import { holidayWriteMeta } from "@/db/holidays";
import { setCheatInterval, setSetting } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { dateInTz, isValidTimeStr } from "@/lib/time";
import { slotIndexAt, slotOf } from "@/lib/schedule";

export const dynamic = "force-dynamic";

function readSettings() {
  const db = getDb();
  const settings = settingsMap(db);
  const today = dateInTz();
  const state = loadScheduleState(db, today);
  const slot = slotOf(today, state.ctx, state.slots);
  return {
    unit: settings.unit === "lb" ? "lb" : "kg",
    /** 训练提醒：工作日档（工作日 + 调休上班日走它，FR-40 / 13.21） */
    reminderTime: settings.reminder_time ?? "22:30",
    /** 训练提醒：休息日档（周末 + 法定节假日走它；默认与工作日档同值 = 分档前行为，v1.49） */
    reminderTimeRestday: settings.reminder_time_restday ?? "22:30",
    workoutReminderOn: settings.workout_reminder_on !== "false",
    restDefaultSec: Number(settings.rest_default_sec ?? 90),
    holidays: holidayWriteMeta(db),
    /** 当前分化方案（只读展示 + 跳转编辑页的入口；改方案在 /api/v1/schemes） */
    scheme: {
      id: state.schemeId,
      name: state.schemeName,
      cycleLen: state.ctx.cycleLen,
      slotIndex: slotIndexAt(today, state.ctx),
      anchorDate: state.anchor.date,
      anchorPosition: state.anchor.position,
      anchorReason: state.anchor.reason ?? "initial",
      templateId: slot?.templateId ?? null,
      slots: state.slots.map((s) => ({ label: s.label, rest: !!s.rest, muscles: s.muscles ?? [] })),
    },
    /** 放纵餐（FR-25）：间隔在设置页改，锚点靠首页「今天真吃了」挪 */
    cheat: cheatSettingView(db),
  };
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  return json(readSettings());
}

export async function PATCH(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const db = getDb();

  if (body.unit !== undefined) {
    if (body.unit !== "kg" && body.unit !== "lb") return badRequest('unit 只能是 "kg" 或 "lb"', undefined, request);
    setSetting(db, "unit", body.unit);
  }
  if (body.reminderTime !== undefined) {
    if (!isValidTimeStr(body.reminderTime)) return badRequest("reminderTime 必须是 HH:mm", undefined, request);
    setSetting(db, "reminder_time", String(body.reminderTime));
  }
  if (body.reminderTimeRestday !== undefined) {
    if (!isValidTimeStr(body.reminderTimeRestday)) {
      return badRequest("reminderTimeRestday 必须是 HH:mm", undefined, request);
    }
    setSetting(db, "reminder_time_restday", String(body.reminderTimeRestday));
  }
  if (body.workoutReminderOn !== undefined) {
    if (typeof body.workoutReminderOn !== "boolean") return badRequest("workoutReminderOn 必须是布尔", undefined, request);
    setSetting(db, "workout_reminder_on", body.workoutReminderOn ? "true" : "false");
  }
  if (body.restDefaultSec !== undefined) {
    const sec = Number(body.restDefaultSec);
    if (!Number.isFinite(sec) || sec < 10 || sec > 600) {
      return badRequest("restDefaultSec 必须在 10~600 秒之间", undefined, request);
    }
    setSetting(db, "rest_default_sec", String(Math.round(sec)));
  }
  if (body.cheatIntervalDays !== undefined) {
    const days = Number(body.cheatIntervalDays);
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      return badRequest("cheatIntervalDays 必须在 1~60 天之间", undefined, request);
    }
    setCheatInterval(db, Math.round(days));
  }

  return writeJson(request, readSettings());
}
