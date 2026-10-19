/**
 * 提醒引擎的服务端组装（MVP+，需求书 4.7 / 13.10 / 13.12）。
 *
 * 职责只有两件事，**判定本身全部复用 lib/reminder 的纯函数**（13.10"只写一份"）：
 *
 * 1. `runReminderTick` —— 幂等的"滴答"：按当前时刻把该生成的事件生成出来
 *    （workout / supplement / cheat / holiday_gap / reanchor 五类），
 *    事件按 `(type, ref_key, date)` 全天只生成一次（FR-37），生成时登记 feishu 渠道的
 *    `dry_run` 投递 —— 并行试运行期只记账不真发，切换后由助手调 `/sent` 升级为 `sent`（10.1）；
 * 2. `dueReminders` —— `GET /api/v1/reminders/due` 的数据源（FR-39）：返回该渠道
 *    **尚无 `sent` 投递**的事件，且投递前把 13.10 的判定**再跑一遍**（练了/打了卡/假期到了就不催）。
 *
 * 定时任务（instrumentation-node.ts）与助手轮询（due）都调 `runReminderTick`，
 * 所以提醒时间（`reminder_time` 设置项）改完立即生效，无需重启（FR-40）；
 * 22:30 只是默认值，判据里的加班 22:30 是另一回事（13.11，固定值不跟配置走）。
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { holidayGapHandledAt } from "@/db/holidays";
import {
  lastActivityDate,
  lastRecordDate,
  loadScheduleState,
  reminderEventExists,
  remindersEnabled,
  reminderTime,
  reminderTimeRestday,
  supplementsFor,
  todayFacts,
  type ScheduleState,
  type TodayFacts,
} from "@/db/queries";
import {
  createAnchorProposal,
  ensureReminderEvent,
  lastRejectedProposalDate,
  markDelivery,
  pendingAnchorProposal,
} from "@/db/writes";
import { hhmmToMinutes, dateInTz, timeInTz, type DateStr, type TimeStr } from "@/lib/time";
import { trainingDaysMissed, slotIndexAt } from "@/lib/schedule";
import {
  decideReminder,
  type ReminderInput,
  type ReminderReason,
} from "@/lib/reminder/decide";
import { decideSupplement, supplementRefKey } from "@/lib/reminder/supplements";
import { dateKind, dayKindApplies, reminderTimeForKind, type DateKind } from "@/lib/reminder/date-kind";
import { holidayGapDue, holidayGapNotice, holidayGapRefKey } from "@/lib/reminder/holiday-gap";
import { cheatRefKey, reanchorRefKey, type ReminderChannel, type ReminderEventType } from "@/lib/reminder/dedup";
import { reanchorAskSuppressed } from "@/lib/reminder/reanchor";
import { cheatWhenText } from "@/lib/caliber/cheat";

/** 事件 payload（存 reminder_event.payload，助手投递用的全部内容都在里面 —— 助手侧零逻辑） */
export interface ReminderEventPayload {
  title: string;
  body: string;
  action: "checkin" | "skip" | "ack" | null;
  partLabel?: string | null;
  nextPartLabel?: string | null;
  reason?: ReminderReason;
  hitNo?: number;
  /** 补剂事件的一键打卡参数（POST /api/v1/checkin 的请求体） */
  checkin?: { kind: "supplement"; ref_id: number } | null;
  dueTime?: TimeStr | null;
  proposalId?: number;
  suggestedPosition?: number;
  coverageEnd?: DateStr | null;
}

/* ———————————————— 日期态与生效提醒时刻（13.21 / v1.49） ———————————————— */

/** 当天日期态（纯函数唯一一份判定）：演练页 / 页面预告 / tick / due 共用 */
export function dayKindOf(facts: TodayFacts, date: DateStr): DateKind {
  return dateKind(date, facts.holiday?.type ?? null);
}

/** 训练提醒的生效时刻与两档原值（tick 的生成闸门、beforeCheckTime 标注、演练页展示共用） */
export function reminderTimeView(db: Db, kind: DateKind): { workday: TimeStr; restday: TimeStr; effective: TimeStr } {
  const workday = reminderTime(db);
  const restday = reminderTimeRestday(db);
  return { workday, restday, effective: reminderTimeForKind(kind, { workday, restday }) };
}

/* ———————————————— 判定输入的组装（今日页预告 / tick / due 三处共用） ———————————————— */

export interface ReminderInputBundle {
  state: ScheduleState;
  facts: TodayFacts;
  today: DateStr;
  at: TimeStr;
  nowTs: number;
}

/**
 * 从库里拼出 13.10 判定表的输入。today.ts 的预告与定时任务共用这一份，
 * 改这里两处同时生效 —— 不给"页面说不会催、实际催了"留缝隙。
 * `checkTime` = **当日生效时刻**（按日期态取档，13.21）：工作日 / 调休上班日走工作日档，
 * 周末 / 法定节假日走休息日档。
 */
export function buildReminderInput(db: Db, bundle: ReminderInputBundle): ReminderInput {
  const { state, facts, today, at, nowTs } = bundle;
  // 明天该练什么：往后找第一个非假期、非休的槽位（第 5 条「明天练 X」文案用）
  const nextPartLabel = (() => {
    for (let i = 1; i <= 8; i++) {
      const d = dateInTz(new Date(nowTs + i * 86_400_000));
      const s = state.slots[slotIndexAt(d, state.ctx)];
      if (!state.holidaySet.has(d) && s && !s.rest) return s.label;
    }
    return "";
  })();
  const holiday = facts.holiday?.type === "holiday" ? facts.holiday : null;

  return {
    date: today,
    partLabel: facts.slot?.label ?? "",
    nextPartLabel,
    holidayName: holiday?.name ?? null,
    isRestSlot: !!facts.slot?.rest,
    skipped: facts.skipped,
    hasTrainingRecord: !!facts.session && (facts.session.status === "doing" || facts.session.status === "done"),
    hasWorkoutCheckin: facts.workoutCheckin,
    overtimeStart: facts.overtimeEarliest?.start ?? null,
    remindersEnabled: remindersEnabled(db),
    checkTime: reminderTimeView(db, dayKindOf(facts, today)).effective,
    at,
  };
}

/* ———————————————— 滴答：生成事件 ———————————————— */

export interface GeneratedEvent {
  id: number;
  type: ReminderEventType;
  refKey: string;
  date: DateStr;
}

export interface ReminderTickResult {
  today: DateStr;
  at: TimeStr;
  generated: GeneratedEvent[];
}

/**
 * 跑一次提醒滴答。**幂等**：事件与投递都靠唯一键去重，重复调用不会多生成；
 * 每次调用都重读设置，所以改提醒时间立即生效（FR-40）。
 */
export function runReminderTick(db: Db, nowTs: number = Date.now()): ReminderTickResult {
  const today = dateInTz(new Date(nowTs));
  const at = timeInTz(new Date(nowTs));
  const state = loadScheduleState(db, today);
  const facts = todayFacts(db, today);
  /** 当天日期态（13.21）：训练提醒取档、补剂适用日都按它判 */
  const kind = dayKindOf(facts, today);
  const generated: GeneratedEvent[] = [];

  const emit = (
    type: ReminderEventType,
    refKey: string,
    payload: ReminderEventPayload,
    opts: { oncePerRef?: boolean } = {},
  ) => {
    if (opts.oncePerRef && reminderEventExists(db, type, refKey)) return;
    const res = ensureReminderEvent(db, { type, refKey, date: today, payload });
    if (res.created) {
      // 并行试运行期（10.1）：投递只记 dry_run，切换后由助手 POST /sent 升级
      markDelivery(db, { eventId: res.id, channel: "feishu", status: "dry_run" });
      generated.push({ id: res.id, type, refKey, date: today });
    }
  };

  // ① 训练提醒（13.10 判定表）：到**当日生效时刻**（按日期态取档，13.21）才生成，练了就静默
  if (hhmmToMinutes(at) >= hhmmToMinutes(reminderTimeView(db, kind).effective)) {
    const decision = decideReminder(buildReminderInput(db, { state, facts, today, at, nowTs }));
    if (decision.verdict === "send") {
      emit("workout", decision.refKey, {
        title: decision.title ?? "",
        body: decision.body ?? "",
        action: decision.action,
        partLabel: decision.partLabel,
        nextPartLabel: decision.nextPartLabel,
        reason: decision.reason,
        hitNo: decision.hitNo,
      });
    }
  }

  // ② 补剂（13.10 第 2 条，并列分支）：**适用日成立**（13.21）且到点、没打卡、当天没生成过才提（FR-33）
  for (const s of supplementsFor(db, today)) {
    const refKey = supplementRefKey(s.id);
    const verdict = decideSupplement({
      supplementId: s.id,
      name: s.name,
      times: s.times,
      takenToday: s.takenToday,
      eventAlreadyGenerated: reminderEventExists(db, "supplement", refKey, today),
      at,
      appliesToday: dayKindApplies(s.dayKind, kind),
    });
    if (verdict.due) {
      emit("supplement", refKey, {
        title: `补剂 · ${s.name}`,
        body: `${s.name}（${s.doseText || "今日剂量见设置"}）还没打卡 · 时点 ${verdict.dueTime ?? at}。吃了就点一下。`,
        action: "checkin",
        checkin: { kind: "supplement", ref_id: s.id },
        dueTime: verdict.dueTime,
      });
    }
  }

  // ③ 放纵餐（3.4 / FR-34）：建议日当天一条，只陈述事实、不命令
  if (facts.cheat.nextDate === today) {
    emit("cheat", cheatRefKey(), {
      title: "放纵餐",
      body:
        facts.cheat.daysSince === null
          ? `还没有放纵餐记录，今天到了建议的日子（${cheatWhenText()}）。吃不吃你定。`
          : `距上次 ${facts.cheat.daysSince} 天，今天到了建议的日子（${cheatWhenText()}）。吃不吃你定。`,
      action: null,
    });
  }

  // ④ 假期表覆盖期自检（13.12 / FR-48）：覆盖期不足 45 天 → 催助手补表；
  //    引用键带覆盖期版本，表补上后键变了、自检自动重新武装；同一版本 30 天节流。
  const gapRef = holidayGapRefKey(state.holidayCoverageEnd);
  if (holidayGapDue({ coverageEnd: state.holidayCoverageEnd, today, lastHandledDate: holidayGapHandledAt(db, gapRef) })) {
    emit("holiday_gap", gapRef, {
      title: "假期表该补了",
      body: holidayGapNotice(state.holidayCoverageEnd),
      action: null,
      coverageEnd: state.holidayCoverageEnd,
    });
  }

  // ⑤ 重锚询问（FR-38）：停练 ≥3 个训练日 → 先问一句再重锚，禁止自动重锚。
  //    待确认的建议在回答前一直有效（oncePerRef：一个建议只生成一次事件）。
  ensureReanchorEvent(db, { state, today, emit });

  return { today, at, generated };
}

function ensureReanchorEvent(
  db: Db,
  args: {
    state: ScheduleState;
    today: DateStr;
    emit: (type: ReminderEventType, refKey: string, payload: ReminderEventPayload, opts?: { oncePerRef?: boolean }) => void;
  },
) {
  const { state, today, emit } = args;
  const missed = trainingDaysMissed(today, state.ctx, state.slots, lastActivityDate(db, today));
  const gateHolds =
    missed >= 3 && !reanchorAskSuppressed(lastRejectedProposalDate(db), lastRecordDate(db));

  let pending = pendingAnchorProposal(db);
  if (!pending && gateHolds) {
    createAnchorProposal(db, { date: today, suggestedPosition: slotIndexAt(today, state.ctx) });
    pending = pendingAnchorProposal(db);
  }
  if (!pending) return;
  emit("reanchor", reanchorRefKey(pending.id), {
    title: "停了几天了",
    body: `停了 ${missed} 个训练日了，要不要把循环重锚到今天？拒绝的话排期不变。`,
    action: "ack",
    proposalId: pending.id,
    suggestedPosition: pending.suggestedPosition,
  }, { oncePerRef: true });
}

/* ———————————————— due：现在该发哪些提醒（FR-39） ———————————————— */

export interface DueEvent {
  id: number;
  type: ReminderEventType;
  ref_key: string;
  date: DateStr;
  title: string;
  body: string;
  action: "checkin" | "skip" | "ack" | null;
  part_label: string | null;
  next_part_label: string | null;
  checkin: { kind: "supplement"; ref_id: number } | null;
  due_time: TimeStr | null;
  proposal_id: number | null;
  suggested_position: number | null;
  coverage_end: DateStr | null;
  delivery: { channel: ReminderChannel; status: "sent" | "dry_run" | null };
}

/**
 * 现在该发哪些提醒：先跑一次 tick（助手轮询即触发，自愈于定时任务停摆），
 * 再取该渠道**尚无 `sent` 投递**的事件，并在投递前把判定再跑一遍（静默复核）——
 * 22:30 生成之后他又练了/打了卡/补剂吃了，轮询到的就不该再发（13.10 第 1、2 条）。
 */
export function dueReminders(
  db: Db,
  nowTs: number = Date.now(),
  channel: ReminderChannel = "feishu",
): { date: DateStr; at: TimeStr; events: DueEvent[] } {
  const tick = runReminderTick(db, nowTs);
  const { today, at } = tick;
  const state = loadScheduleState(db, today);
  const facts = todayFacts(db, today);
  const nowTs2 = Date.now();

  // 补剂当前的打卡状态与适用日（生成事件之后他才打卡 / 当天把适用日改掉 → 复核时要从 due 里摘掉）
  const supplementToday = supplementsFor(db, today);
  const takenBySupplement = new Map(supplementToday.map((s) => [String(s.id), s.takenToday]));
  const kindToday = dayKindOf(facts, today);
  const appliesBySupplement = new Map(
    supplementToday.map((s) => [String(s.id), dayKindApplies(s.dayKind, kindToday)]),
  );
  const pendingProposal = pendingAnchorProposal(db);
  const missed = trainingDaysMissed(today, state.ctx, state.slots, lastActivityDate(db, today));
  const reanchorGateHolds =
    !!pendingProposal &&
    missed >= 3 &&
    !reanchorAskSuppressed(lastRejectedProposalDate(db), lastRecordDate(db));

  const rows = db
    .select({
      event: schema.reminderEvent,
      deliveryStatus: schema.reminderDelivery.status,
    })
    .from(schema.reminderEvent)
    .leftJoin(
      schema.reminderDelivery,
      and(
        eq(schema.reminderDelivery.eventId, schema.reminderEvent.id),
        eq(schema.reminderDelivery.channel, channel),
      ),
    )
    .all();

  const events: DueEvent[] = [];
  for (const { event, deliveryStatus } of rows) {
    if (deliveryStatus === "sent") continue; // 该渠道已真实投递（dry_run 只是记账，10.1）
    // 时效性：训练/补剂/放纵餐只管当天；holiday_gap 与待确认的重锚建议在处理前一直有效
    const standing = event.type === "holiday_gap" || event.type === "reanchor";
    if (!standing && event.date !== today) continue;

    const payload = (event.payload ?? {}) as ReminderEventPayload;
    let applies = true;
    switch (event.type) {
      case "workout": {
        const decision = decideReminder(buildReminderInput(db, { state, facts, today, at, nowTs: nowTs2 }));
        applies = decision.verdict === "send";
        break;
      }
      case "supplement":
        // 复核两条：还没打卡、且这条补剂的适用日在今天仍成立（13.21）
        applies =
          takenBySupplement.get(event.refKey.replace(/^supp:/, "")) === false &&
          appliesBySupplement.get(event.refKey.replace(/^supp:/, "")) !== false;
        break;
      case "cheat":
        // 他今天真吃了 → 锚点已挪走、nextDate 不再是今天
        applies = facts.cheat.nextDate === event.date;
        break;
      case "holiday_gap":
        // 引用键还指着当前覆盖期版本、且覆盖期仍不足才有效（表补上后旧事件自动作废）
        applies = holidayGapRefKey(state.holidayCoverageEnd) === event.refKey && !state.holidayCoverageEnough;
        break;
      case "reanchor":
        applies = reanchorGateHolds && pendingProposal?.id === Number(event.refKey.replace(/^proposal:/, ""));
        break;
    }
    if (!applies) continue;

    events.push({
      id: event.id,
      type: event.type,
      ref_key: event.refKey,
      date: event.date,
      title: payload.title ?? "",
      body: payload.body ?? "",
      action: payload.action ?? null,
      part_label: payload.partLabel ?? null,
      next_part_label: payload.nextPartLabel ?? null,
      checkin: payload.checkin ?? null,
      due_time: payload.dueTime ?? null,
      proposal_id: payload.proposalId ?? null,
      suggested_position: payload.suggestedPosition ?? null,
      coverage_end: payload.coverageEnd ?? null,
      delivery: { channel, status: deliveryStatus ?? null },
    });
  }

  events.sort((a, b) => a.id - b.id);
  return { date: today, at, events };
}
