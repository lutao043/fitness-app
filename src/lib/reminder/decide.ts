/**
 * 训练提醒判定（需求书 13.10 的判定表 —— **唯一顺序，不得调整**）。
 *
 * 这里是全项目唯一的一份判定实现：页面预告、22:30 定时任务、`GET /api/v1/reminders/due`
 * 三处共用它（写三套 if，早晚会出现"页面说不会催、实际催了"这种最难查的故障 —— 踩坑第 26 条）。
 *
 * 判定表（命中一条即结论，不再往下判）：
 *   1 当天有训练记录 / 存在 doing 会话 / 已打卡 → 全天静默
 *   2 补剂：已打卡 → 该条补剂提醒消失（并列分支，见 supplements.ts）
 *   3 法定节假日 → 不发训练提醒（补剂提醒照发）
 *   4 循环位「休」 → 不发训练提醒
 *   5 当天已顺延 → 发「今天已顺延，明天练 X」+ 一键确认
 *   6 加班开始 ≥ 22:30 → 豁免：不发"你怎么没练"
 *   7 加班开始 < 22:30 → 发「赶不上，建议顺延」+ 一键顺延（不是一键打卡）
 *   8 以上都不命中 → 发「今天该练 X，还没记录」+ 一键打卡
 *
 * 两个固定项，任何配置都不得联动改动：
 * - **加班判据固定 22:30**（3.3：训练 21:00 结束 + 回家洗澡），与"提醒时间"这个可配置项无关；
 * - 一天多条加班取**开始最早**的那条（13.11，对他最不利的那条）。
 */

import { hhmmToMinutes, type DateStr, type TimeStr } from "@/lib/time";

/** 加班判据（3.3 / 13.11）—— 固定值，不跟着提醒时间配置走。 */
export const OVERTIME_JUDGE_TIME: TimeStr = "22:30";

export type ReminderReason =
  | "disabled"
  | "recorded"
  | "holiday"
  | "rest"
  | "skipped"
  | "overtime_ok"
  | "overtime_late"
  | "prompt";

/** 提醒里带的动作（FR-30：从提醒到完成打卡 ≤ 1 次点击） */
export type ReminderAction = "checkin" | "skip" | "ack";

export interface ReminderStep {
  /** 判定表里的序号（0 = 训练提醒总开关，判定链之前的短路项） */
  no: number;
  name: string;
  hit: boolean;
  detail: string;
}

export interface ReminderInput {
  date: DateStr;
  /** 今天该练的部位标签（如「背+二头」） */
  partLabel: string;
  /** 明天该练的部位标签（第 5 条文案用） */
  nextPartLabel: string;
  /** 当天法定节假日名；不是假期传 null */
  holidayName: string | null;
  /** 循环位是不是「休」 */
  isRestSlot: boolean;
  /** 当天是否已顺延 */
  skipped: boolean;
  /** 当天存在 status ∈ {doing, done} 的会话（**doing 未落库也算练了**） */
  hasTrainingRecord: boolean;
  /** 当天有 workout 打卡（checkin kind=workout） */
  hasWorkoutCheckin: boolean;
  /** 当天开始最早的加班开始时间（HH:mm）；没有加班传 null */
  overtimeStart: TimeStr | null;
  /** 训练提醒总开关（FR-40）：设置项，关了就是长期"别催我" */
  remindersEnabled: boolean;
  /** 配置的提醒时间（只用于预览"还没到判定时刻"的标注） */
  checkTime: TimeStr;
  /** 本次判定时刻（22:30 定时任务 / 页面演练） */
  at: TimeStr;
}

export interface ReminderDecision {
  verdict: "silent" | "send";
  reason: ReminderReason;
  /** 命中的判定步骤序号 */
  hitNo: number;
  steps: ReminderStep[];
  /** 今天该练的部位（文案用） */
  partLabel: string;
  /** 推送标题（会发时才有） */
  title: string | null;
  /** 推送正文 */
  body: string | null;
  action: ReminderAction | null;
  /** 一键顺延时，次日要补的部位 */
  nextPartLabel: string | null;
  /** 判定时刻早于配置的提醒时间 → 结论要标注"还没到判定时刻" */
  beforeCheckTime: boolean;
  /** 事件去重引用键（workout → "workout"；13.10 去重键 = type + ref_key + date） */
  refKey: string;
}

export const WORKOUT_REF_KEY = "workout";

export function decideReminder(input: ReminderInput): ReminderDecision {
  const { partLabel, nextPartLabel } = input;
  const recorded = input.hasTrainingRecord || input.hasWorkoutCheckin;
  const overtimeStart = input.overtimeStart;
  const overtimeMinutes = overtimeStart ? hhmmToMinutes(overtimeStart) : null;
  const judgeMinutes = hhmmToMinutes(OVERTIME_JUDGE_TIME);
  const overtimeOk = overtimeMinutes !== null && overtimeMinutes >= judgeMinutes;
  const overtimeLate = overtimeMinutes !== null && overtimeMinutes < judgeMinutes;

  const recordText = input.hasTrainingRecord
    ? "已有训练记录（进行中的 doing 会话也算）"
    : input.hasWorkoutCheckin
      ? "已在提醒里一键打卡（无明细）"
      : "今天还没有任何训练记录";

  const steps: ReminderStep[] = [
    {
      no: 0,
      name: "训练提醒总开关",
      hit: !input.remindersEnabled,
      detail: input.remindersEnabled ? "开着" : "已关闭（我的 → 提醒时间）",
    },
    {
      no: 1,
      name: "有训练记录 / 正在训练 / 已打卡",
      hit: recorded,
      detail: recordText,
    },
    {
      no: 3,
      name: "法定节假日",
      hit: !!input.holidayName,
      detail: input.holidayName ? `${input.holidayName} · 假期不占循环位` : "今天不是法定节假日",
    },
    {
      no: 4,
      name: "循环位「休」",
      hit: input.isRestSlot,
      detail: input.isRestSlot ? "今天是休息日" : `今天是训练日（${partLabel}）`,
    },
    {
      no: 5,
      name: "当天已顺延",
      hit: input.skipped,
      detail: input.skipped ? `已顺延 · 明天补「${partLabel}」` : "今天没有顺延记录",
    },
    {
      no: 6,
      name: `加班豁免（开始 ≥ ${OVERTIME_JUDGE_TIME}）`,
      hit: overtimeOk,
      detail: overtimeStart ? `今晚 ${overtimeStart} 加班` : "今天没有加班记录",
    },
    {
      no: 7,
      name: `加班但赶不上（开始 < ${OVERTIME_JUDGE_TIME}）`,
      hit: overtimeLate,
      detail: overtimeStart ? `今晚 ${overtimeStart} 加班 · 赶不上 21:00 收工` : "今天没有加班记录",
    },
    {
      no: 8,
      name: "以上都不命中",
      hit: !recorded && !input.holidayName && !input.isRestSlot && !input.skipped && !overtimeStart,
      detail: overtimeStart ? "有加班记录，走第 6 / 7 条" : "无记录、无豁免 —— 正常催练",
    },
  ];

  const beforeCheckTime = hhmmToMinutes(input.at) < hhmmToMinutes(input.checkTime);
  const base = {
    steps,
    beforeCheckTime,
    refKey: WORKOUT_REF_KEY,
    partLabel,
    nextPartLabel: null as string | null,
  };

  if (!input.remindersEnabled) {
    return {
      ...base,
      verdict: "silent",
      reason: "disabled",
      hitNo: 0,
      title: null,
      body: null,
      action: null,
    };
  }
  if (recorded) {
    return {
      ...base,
      verdict: "silent",
      reason: "recorded",
      hitNo: 1,
      title: null,
      body: null,
      action: null,
    };
  }
  if (input.holidayName) {
    return {
      ...base,
      verdict: "silent",
      reason: "holiday",
      hitNo: 3,
      title: null,
      body: null,
      action: null,
    };
  }
  if (input.isRestSlot) {
    return {
      ...base,
      verdict: "silent",
      reason: "rest",
      hitNo: 4,
      title: null,
      body: null,
      action: null,
    };
  }
  if (input.skipped) {
    return {
      ...base,
      verdict: "send",
      reason: "skipped",
      hitNo: 5,
      title: `今天已顺延`,
      body: `今天已顺延，明天练「${nextPartLabel}」。`,
      action: "ack",
    };
  }
  if (overtimeOk) {
    return {
      ...base,
      verdict: "silent",
      reason: "overtime_ok",
      hitNo: 6,
      title: null,
      body: null,
      action: null,
    };
  }
  if (overtimeLate) {
    return {
      ...base,
      verdict: "send",
      reason: "overtime_late",
      hitNo: 7,
      title: "加班赶不上",
      body: `今晚 ${overtimeStart} 加班，赶不上。建议顺延，明天接着练「${partLabel}」。`,
      action: "skip",
      nextPartLabel: partLabel,
    };
  }
  return {
    ...base,
    verdict: "send",
    reason: "prompt",
    hitNo: 8,
    title: "今天还没记录",
    body: `今天该练「${partLabel}」，还没记录。练了就点一下：`,
    action: "checkin",
  };
}

/** 结论文案（页面预告 / 演练面板用；只有陈述，不含任何按钮文案） */
export function reminderStatusText(decision: ReminderDecision, checkTime: TimeStr): string {
  const early = decision.beforeCheckTime ? `（还没到判定时刻 ${checkTime}）` : "";
  switch (decision.reason) {
    case "disabled":
      return "训练提醒已关闭（我的 → 提醒时间）· 今天不发，与「加班豁免」无关。";
    case "recorded":
      return `${decision.steps[1].detail} · ${checkTime} 完全静默。`;
    case "holiday":
      return "今天法定节假日 · 不发训练提醒。";
    case "rest":
      return "今天循环位为「休」· 不发训练提醒。";
    case "skipped":
      return `已顺延 · 提醒会带「已顺延」并给一键确认。${early}`;
    case "overtime_ok":
      return `加班豁免（${OVERTIME_JUDGE_TIME} 起算）· 今晚不发「你怎么没练」。`;
    case "overtime_late":
      return `加班赶不上 · 提醒会建议顺延，给一键顺延（不是一键打卡）。${early}`;
    default:
      return `今天无训练记录 → ${checkTime} 将提醒「今天该练 ${decision.partLabel}」，附一键打卡。${early}`;
  }
}
