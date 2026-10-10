/**
 * 今日页的数据总装（GET /api/v1/today 与首页服务端组件共用）。
 *
 * 需求书第 7 章约定的字段（date / weekday / holiday / part / exercises / overtime / cheat / recovery）
 * 全在这里；UI 需要的附加信息（欠账、streak、提醒预告、假期表覆盖期、跨零点回执）一并给出。
 * 判定一律调 `@/lib` 的纯函数 —— 页面、定时任务、接口三处共用同一份实现（踩坑第 26 条）。
 */

import type { Db } from "@/db/client";
import {
  cardioList,
  cardioOn,
  dayKindOf,
  latestBodyMetric,
  latestSetByExerciseVariant,
  lastActivityDate,
  lastRecordDate,
  loadScheduleState,
  partFrequency,
  recentSessionReceipt,
  recordedDates,
  recoveryRows,
  remindersEnabled,
  reminderTime,
  settingsMap,
  supplementsFor,
  todayFacts,
  type DayKind,
  type ExerciseView,
  type RecoveryRow,
} from "@/db/queries";
import { userRow } from "@/server/auth";
import { addDays, dateInTz, formatCn, timeInTz, type DateStr, type TimeStr } from "@/lib/time";
import { normalizeSummary, sessionCompletionOf } from "@/server/session";
import {
  extraShiftSummary,
  isTrainingDay,
  owedParts,
  owedText,
  needsReanchorBeforeSkip,
  trainingDaysMissed,
  shouldAskReanchor,
  deferralOf,
  type Deferral,
} from "@/lib/schedule";
import { asWeightUnit, type WeightUnit } from "@/lib/units";
import { buildReminderInput } from "@/server/reminders";
import { streak, muscleGroups } from "@/lib/caliber";
import { decideReminder, reminderStatusText, type ReminderDecision } from "@/lib/reminder/decide";
import {
  holidayCoverageText,
  holidayGapDue,
  holidayGapNotice,
  holidayGapRefKey,
} from "@/lib/reminder/holiday-gap";
import { holidayGapHandledAt } from "@/db/holidays";

export interface TodayExercise extends ExerciseView {
  /** 「照上次填」（FR-7）：同动作 + 同变体的最近一组 */
  lastByVariant: Record<
    string,
    { weightKg: number | null; reps: number | null; durationSec: number | null; doneAt: string } | null
  >;
}

export interface TodayPayload {
  date: DateStr;
  weekday: string;
  formatted: string;
  time: TimeStr;
  holiday: { name: string; type: "holiday" | "workday" } | null;
  scheme: { id: string; name: string; cycleLen: number; slotIndex: number; templateId: number | null };
  part: string;
  /** true = 今天临时改练了别的部位（FR-4），排期与锚点都没动 */
  partOverride: boolean;
  /** 展示单位（§1.1）：库里一律 kg，页面按它换算重量与体重 */
  unit: WeightUnit;
  mode: "gym" | "home";
  isRestDay: boolean;
  isTrainingDay: boolean;
  /**
   * 这天为什么不是"锚点直推的正常一天"（v1.28）：`holiday` / `skip` / `extra_shift` / `null`。
   * 与 `GET /api/v1/schedule/upcoming` 的 `deferred` **同源同义**（同一个纯函数）—— 助手对拍两处要一致。
   */
  deferred: Deferral | null;
  skipped: boolean;
  exercises: TodayExercise[];
  session: {
    id: number;
    clientId: string;
    status: string;
    part: string;
    mode: string;
    startedAt: string | null;
    endedAt: string | null;
    summary: unknown;
    /** 完成度（issue #45）：主标 `已记组数 / 目标之和`、副标 `做满动作数 / 参与动作数` */
    completion?: { setsText: string; exercisesText: string; totalSets: number };
    /** 加练（13.17）：非训练日真练了的那一场（首页出「加练」标记与顺延提示） */
    isExtra: boolean;
  } | null;
  checkin: { workout: boolean };
  /** 目标体重（user 表；距目标与目标卡统一从这读，别再硬编码 65） */
  target: number | null;
  /** 今日补剂清单（打卡段用；takenToday 按 (date, kind=supplement, ref_id) 判） */
  supplements: { id: number; name: string; doseText: string; times: string[]; takenToday: boolean }[];
  overtime: { id: number; start: string; note: string | null; verdict: "ok" | "late" }[];
  overtimeEarliest: { start: string; verdict: "ok" | "late" } | null;
  /**
   * 加练（13.17）已生效时的提示：今天没休的「休」落在哪天 + 接下来练什么。
   * 用**已含位点**的排期算（不许页面自己算一份）。
   */
  extraShift: {
    restDate: DateStr | null;
    nextTraining: { date: DateStr; part: string } | null;
  } | null;
  /** 今天 / 明天的日子类型（13.11 / v1.20）：加班卡与判定预告按它决定要不要判定"耽误训练" */
  dayTypes: Record<DateStr, DayKind>;
  cheat: { /** daysSince 为 null = 从没记过放纵餐（显示「还没有记录」，别把安装日锚点当真事） */
    daysSince: number | null;
    nextDate: DateStr;
    when: string;
    intervalDays: number;
  };
  recovery: RecoveryRow[];
  /** FR-20：最近 7 天各大部位练了几天（展示映射 13.15），看有没有漏练 */
  partFrequency: { group: string; days: number }[];
  /** 有氧（FR-50 / v1.16）：今天记了没 + 近 7 天合计（不算出勤、不进容量、不参与 streak，13.4/13.6） */
  cardio: { today: { minutes: number; note: string | null } | null; weekMinutes: number; weekDays: number };
  streak: number;
  debt: { owed: { date: DateStr; part: string }[]; text: string | null; needsReanchorBeforeSkip: boolean };
  reanchor: { trainingDaysMissed: number; shouldAsk: boolean };
  reminders: { enabled: boolean; time: TimeStr; statusText: string; decision: ReminderDecision };
  holidayGap: { enough: boolean; coverageEnd: DateStr | null; text: string | null; due: boolean };
  /** 训练结束 6 小时内的回执（13.3 / FR-45）：`date` 是那场会话的归属日，可能不是今天 */
  receipt: { date: DateStr; time: string; hoursSince: number } | null;
  body: {
    latestMorning: { date: DateStr; weightKg: number; slot: string } | null;
    latestAny: { date: DateStr; weightKg: number; slot: string } | null;
    isToday: boolean;
  };
}

export function buildToday(
  db: Db,
  mode: "gym" | "home" = "gym",
  now: Date = new Date(),
  at?: TimeStr,
  /**
   * 改练其他部位（FR-4）：今天临时用这个槽位的清单。
   * **只是今天的显示覆盖** —— 锚点、循环推进、欠账、streak 全按原排期算（不重锚循环）。
   */
  partTemplateId?: number | null,
): TodayPayload {
  const today = dateInTz(now);
  const nowTs = now.getTime();
  const state = loadScheduleState(db, today);
  const facts = todayFacts(db, today);
  const reminderConfigured = reminderTime(db);
  const at_ = at ?? timeInTz(now);

  const cycleSlot = facts.slot;
  const overrideSlot =
    partTemplateId === undefined || partTemplateId === null
      ? null
      : (state.slots.find((s) => s.templateId === partTemplateId) ?? null);
  const slot = overrideSlot ?? cycleSlot;
  const list = (mode === "home" ? slot?.home : slot?.gym) ?? [];
  const history = latestSetByExerciseVariant(db);
  const exercises: TodayExercise[] = list.map((ex) => {
    const byVariant = history.get(ex.exerciseId);
    const lastByVariant: TodayExercise["lastByVariant"] = {};
    for (const variant of [null, ...ex.variants.map((v) => v.id)]) {
      const key = variant === null ? "default" : String(variant);
      const last = byVariant?.get(key);
      lastByVariant[key] = last
        ? { weightKg: last.weightKg, reps: last.reps, durationSec: last.durationSec, doneAt: last.doneAt }
        : null;
    }
    return { ...ex, lastByVariant };
  });

  const lastRecord = lastRecordDate(db);
  const owed = owedParts(today, state.ctx, state.slots, lastRecord);
  const records = recordedDates(db);
  const streakDays = streak({
    today,
    ctx: state.ctx,
    slots: state.slots,
    hasRecord: (d) => records.has(d),
  });
  // 停练计数用「有动作」口径：顺延也算有动作，否则连续顺延会被当成停练天天问重锚（pause.ts）
  const missed = trainingDaysMissed(today, state.ctx, state.slots, lastActivityDate(db, today));

  // 判定输入的组装与定时任务/`reminders/due` 共用一份（buildReminderInput），保证三处同源
  const decision = decideReminder(
    buildReminderInput(db, { state, facts, today, at: at_, nowTs }),
  );

  const gapRef = holidayGapRefKey(state.holidayCoverageEnd);
  const gapDue = holidayGapDue({
    coverageEnd: state.holidayCoverageEnd,
    today,
    lastHandledDate: holidayGapHandledAt(db, gapRef),
  });

  const body = latestBodyMetric(db, today);
  // 训练结束 6 小时内的回执（13.3 / FR-45）：避免练完看首页收到"今天该练背"这种荒谬感。
  // 必须**跨自然日**取最近一场已收工的会话 —— 会话按 started_at 归属（13.3），
  // 23:40 开练、00:20 收工那场在次日早晨用 sessionsOn(today) 是查不到的，
  // 而那正是这条回执要解决的场景（查得到才轮得到「昨晚已练完」）。
  const receiptRow = (() => {
    const found = recentSessionReceipt(db, nowTs);
    if (!found?.session.endedAt) return null;
    const ts = Date.parse(found.session.endedAt);
    if (!Number.isFinite(ts)) return null;
    return {
      date: found.session.date,
      time: timeInTz(new Date(ts)),
      hoursSince: Math.round(found.hoursSince),
    };
  })();

  // 加练（13.17）：今天那场是加练且已开练 → 给出「今天没休的休息顺延到哪 + 接下来练什么」。
  // 位点在开练时已经落库，这里用**新的**排期算（提示与排期同源，页面不许自己算一份）。
  const extraShift =
    facts.session?.isExtra && (facts.session.status === "doing" || facts.session.status === "done")
      ? extraShiftSummary({
          date: today,
          ctx: state.ctx,
          slots: state.slots,
          deferredRest: !state.holidaySet.has(today) && !!facts.slot?.rest,
        })
      : null;

  // 今天 / 明天的日子类型（13.11 / v1.20）：休息日 / 假期的加班只作记录，不判"耽误训练"
  const dayTypes: Record<DateStr, DayKind> = {
    [today]: dayKindOf(today, state),
    [addDays(today, 1)]: dayKindOf(addDays(today, 1), state),
  };

  // FR-20：只展示他方案里会练到的部位，没练到的显示 0 天 —— 漏练一眼看出。
  // 部位按动作细分肌群解析到大部位（13.15 展示映射）；无明细的打卡日没法归部位，不计。
  const plannedGroups = new Set<string>();
  for (const s of state.slots) {
    if (s.rest) continue;
    for (const g of muscleGroups(s.muscles ?? [])) plannedGroups.add(g);
  }
  const freqByGroup = new Map(partFrequency(db, today, 7).map((r) => [r.group, r.days]));
  const partFreqRows = (
    plannedGroups.size > 0
      ? [...plannedGroups].map((g) => ({ group: g, days: freqByGroup.get(g) ?? 0 }))
      : partFrequency(db, today, 7).map((r) => ({ group: r.group, days: r.days }))
  ).sort((a, b) => b.days - a.days || a.group.localeCompare(b.group));

  // 有氧（FR-50）：今天记了没 + 近 7 天合计（只做记录，不进出勤/容量/streak，13.4 / 13.6）
  const cardioToday = cardioOn(db, today);
  const cardioRecent = cardioList(db, { from: addDays(today, -6), to: today });

  return {
    date: today,
    weekday: formatCn(today).split(" ").at(-1) ?? "",
    formatted: formatCn(today),
    time: at_,
    holiday: facts.holiday,
    scheme: {
      id: state.schemeId,
      name: state.schemeName,
      cycleLen: state.ctx.cycleLen,
      slotIndex: facts.slotIndex,
      // 「把这套存回模板」要用：这一天这个场景对应的槽位模板 id
      templateId: slot?.templateId ?? null,
    },
    target: userRow(db)?.targetWeightKg ?? null,
    supplements: supplementsFor(db, today).map((s) => ({
      id: s.id,
      name: s.name,
      doseText: s.doseText,
      times: s.times,
      takenToday: s.takenToday,
    })),
    part: slot?.label ?? "",
    partOverride: overrideSlot !== null,
    unit: asWeightUnit(settingsMap(db).unit),
    mode,
    // 改练其他部位时按所选槽位判休（覆盖只能是非休槽位，所以这里必为 false）
    isRestDay: slot ? !!slot.rest : facts.isRestDay,
    isTrainingDay: isTrainingDay(today, state.ctx, state.slots),
    deferred: deferralOf(today, state.ctx),
    skipped: facts.skipped,
    exercises,
    session: facts.session
      ? {
          ...facts.session,
          summary: normalizeSummary(facts.session.summary, facts.session),
          // 完成度（issue #45）：与记录页**同一处实现**（服务端算好，页面只渲染）
          completion:
            facts.session.status === "planned" ? undefined : sessionCompletionOf(db, facts.session.id),
        }
      : null,
    checkin: { workout: facts.workoutCheckin },
    overtime: facts.overtime,
    overtimeEarliest: facts.overtimeEarliest,
    extraShift: extraShift
      ? {
          restDate: extraShift.restDate,
          nextTraining: extraShift.nextTraining
            ? { date: extraShift.nextTraining.date, part: extraShift.nextTraining.label }
            : null,
        }
      : null,
    dayTypes,
    cheat: {
      daysSince: facts.cheat.daysSince,
      nextDate: facts.cheat.nextDate,
      when: "中午",
      intervalDays: facts.cheat.intervalDays,
    },
    recovery: recoveryRows(db, state, today, nowTs),
    partFrequency: partFreqRows,
    cardio: {
      today: cardioToday ? { minutes: cardioToday.minutes, note: cardioToday.note ?? null } : null,
      weekMinutes: cardioRecent.reduce((sum, r) => sum + r.minutes, 0),
      weekDays: cardioRecent.length,
    },
    streak: streakDays,
    debt: {
      owed,
      text: owedText(owed),
      needsReanchorBeforeSkip: needsReanchorBeforeSkip(owed),
    },
    reanchor: { trainingDaysMissed: missed, shouldAsk: shouldAskReanchor(missed) },
    reminders: {
      enabled: remindersEnabled(db),
      time: reminderConfigured,
      statusText: reminderStatusText(decision, reminderConfigured),
      decision,
    },
    holidayGap: {
      enough: state.holidayCoverageEnough,
      coverageEnd: state.holidayCoverageEnd,
      text: state.holidayCoverageEnough ? null : holidayGapNotice(state.holidayCoverageEnd),
      due: gapDue,
    },
    receipt: receiptRow,
    body: {
      latestMorning: body.latestMorning
        ? { date: body.latestMorning.date, weightKg: body.latestMorning.weightKg, slot: body.latestMorning.slot }
        : null,
      latestAny: body.latestAny
        ? { date: body.latestAny.date, weightKg: body.latestAny.weightKg, slot: body.latestAny.slot }
        : null,
      isToday: body.latestMorning?.date === today || body.latestAny?.date === today,
    },
  };
}

/** 覆盖期展示（设置页/我的页用） */
export function holidayCoverageLabel(coverageEnd: DateStr | null): string {
  return holidayCoverageText(coverageEnd);
}
