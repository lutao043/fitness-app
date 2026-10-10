/**
 * 提醒判定单测（需求书 13.10 的判定表逐条 + 加班判据固定 + 补剂分支 + 假期表自检 + 去重键）。
 */

import { describe, expect, it } from "vitest";
import {
  decideReminder,
  decideSupplement,
  OVERTIME_JUDGE_TIME,
  reminderStatusText,
  type ReminderInput,
} from "@/lib/reminder";
import {
  holidayCoverageEnd,
  holidayCoverageEnough,
  holidayCoverageText,
  holidayGapDue,
  holidayGapNotice,
  holidayGapRefKey,
} from "@/lib/reminder";
import { deliveryDedupeKey, eventDedupeKey, reanchorRefKey, cheatRefKey } from "@/lib/reminder";
import { reanchorAskSuppressed, shouldProposeReanchor } from "@/lib/reminder";
import { earliestOvertime, overtimeVerdict, overtimeVerdictText } from "@/lib/overtime";
import { HOLIDAY_SEED_2026 } from "@/data";

const BASE: ReminderInput = {
  date: "2026-09-28",
  partLabel: "背+二头",
  nextPartLabel: "胸+三头",
  holidayName: null,
  isRestSlot: false,
  skipped: false,
  hasTrainingRecord: false,
  hasWorkoutCheckin: false,
  overtimeStart: null,
  remindersEnabled: true,
  checkTime: "22:30",
  at: "22:30",
};

const decide = (patch: Partial<ReminderInput> = {}) => decideReminder({ ...BASE, ...patch });

describe("13.10 判定表逐条", () => {
  it("第 1 条：有训练记录 → 全天静默", () => {
    const d = decide({ hasTrainingRecord: true });
    expect(d.verdict).toBe("silent");
    expect(d.reason).toBe("recorded");
    expect(d.hitNo).toBe(1);
    expect(d.body).toBeNull();
  });

  it("第 1 条：只有 doing 会话（未落库）也算练了", () => {
    // hasTrainingRecord 由调用方把 status ∈ {doing, done} 都算进去
    const d = decide({ hasTrainingRecord: true });
    expect(d.verdict).toBe("silent");
  });

  it("第 1 条：一键打卡后 → 全天静默", () => {
    const d = decide({ hasWorkoutCheckin: true });
    expect(d.verdict).toBe("silent");
    expect(d.steps[1].detail).toContain("一键打卡");
  });

  it("第 1 条优先于第 3 条：假期练了也静默", () => {
    const d = decide({ holidayName: "国庆节", hasTrainingRecord: true });
    expect(d.reason).toBe("recorded");
  });

  it("第 3 条：法定节假日 → 不发训练提醒", () => {
    const d = decide({ holidayName: "中秋节" });
    expect(d.verdict).toBe("silent");
    expect(d.reason).toBe("holiday");
    expect(d.hitNo).toBe(3);
  });

  it("第 4 条：循环位「休」→ 不发训练提醒", () => {
    const d = decide({ isRestSlot: true, partLabel: "休" });
    expect(d.verdict).toBe("silent");
    expect(d.reason).toBe("rest");
    expect(d.hitNo).toBe(4);
  });

  it("第 5 条：当天已顺延 → 发「今天已顺延，明天练 X」+ 一键确认", () => {
    const d = decide({ skipped: true });
    expect(d.verdict).toBe("send");
    expect(d.reason).toBe("skipped");
    expect(d.body).toContain("明天练「胸+三头」");
    expect(d.action).toBe("ack");
    expect(d.body).not.toContain("你怎么没练");
  });

  it("第 6 条：加班 23:00 → 豁免，不发「你怎么没练」", () => {
    const d = decide({ overtimeStart: "23:00" });
    expect(d.verdict).toBe("silent");
    expect(d.reason).toBe("overtime_ok");
    expect(d.hitNo).toBe(6);
  });

  it("第 7 条：加班 20:00 → 发「赶不上，建议顺延」+ 一键顺延（不是一键打卡）", () => {
    const d = decide({ overtimeStart: "20:00" });
    expect(d.verdict).toBe("send");
    expect(d.reason).toBe("overtime_late");
    expect(d.action).toBe("skip");
    expect(d.body).toContain("建议顺延");
    expect(d.body).not.toContain("你怎么没练");
    expect(d.body).toContain("背+二头"); // 明天接着练的部位 = 今天该练的
  });

  it("第 8 条：以上都不命中 → 催练 + 一键打卡", () => {
    const d = decide();
    expect(d.verdict).toBe("send");
    expect(d.reason).toBe("prompt");
    expect(d.action).toBe("checkin");
    expect(d.body).toContain("今天该练「背+二头」");
  });

  it("总开关（第 0 条）短路一切：关了就不发", () => {
    const d = decide({ remindersEnabled: false, overtimeStart: "20:00" });
    expect(d.verdict).toBe("silent");
    expect(d.reason).toBe("disabled");
    expect(d.hitNo).toBe(0);
  });

  it("加班判据固定 22:30，不跟着提醒时间配置漂", () => {
    expect(OVERTIME_JUDGE_TIME).toBe("22:30");
    // 把提醒时间/演练时刻改到 22:00，判据仍是 22:30
    expect(decide({ at: "22:00", checkTime: "22:00", overtimeStart: "22:15" }).reason).toBe(
      "overtime_late",
    );
    expect(decide({ at: "22:00", checkTime: "22:00", overtimeStart: "22:30" }).reason).toBe(
      "overtime_ok",
    );
  });

  it("判定时刻早于配置时间 → 结果标注「还没到判定时刻」", () => {
    const d = decide({ at: "21:00", checkTime: "22:30" });
    expect(d.beforeCheckTime).toBe(true);
    expect(reminderStatusText(d, "22:30")).toContain("还没到判定时刻");
  });

  it("只看当天开始最早的那条加班（13.11）", () => {
    const list = [
      { id: 1, date: "2026-09-28", start: "23:00" },
      { id: 2, date: "2026-09-28", start: "20:00" },
      { id: 3, date: "2026-09-28", start: "22:45" },
    ];
    expect(earliestOvertime(list)?.start).toBe("20:00");
    expect(overtimeVerdict("22:29")).toBe("late");
    expect(overtimeVerdict("22:30")).toBe("ok");
    expect(overtimeVerdictText("22:30")).toBe("来得及");
  });
});

describe("补剂提醒（13.10 第 2 条，并列分支）", () => {
  const base = {
    supplementId: 1,
    name: "维生素 D3",
    times: ["09:30"],
    takenToday: false,
    eventAlreadyGenerated: false,
    at: "09:30",
  };

  it("到点且没打卡 → 会提", () => {
    const r = decideSupplement(base);
    expect(r.due).toBe(true);
    expect(r.dueTime).toBe("09:30");
  });

  it("没到点 → 不提", () => {
    expect(decideSupplement({ ...base, at: "09:29" }).reason).toBe("not_yet");
  });

  it("已打卡 → 该条补剂提醒消失", () => {
    expect(decideSupplement({ ...base, takenToday: true }).reason).toBe("taken");
  });

  it("同一天已生成过事件 → 不重复提（去重）", () => {
    expect(decideSupplement({ ...base, eventAlreadyGenerated: true }).reason).toBe("already_sent");
  });

  it("多个时点取最早的那个已过时点", () => {
    const r = decideSupplement({ ...base, times: ["13:30", "09:30", "22:30"], at: "14:00" });
    expect(r.dueTime).toBe("09:30");
  });

  it("假期不影响补剂（与训练提醒相互独立）", () => {
    // 训练提醒在假期静默，但补剂判定里根本没有"假期"这个输入
    expect(decideSupplement(base).due).toBe(true);
  });
});

describe("假期表覆盖期自检（13.12 / FR-48）", () => {
  const seedList = Object.entries(HOLIDAY_SEED_2026).map(([date, v]) => ({ date, type: v.type }));

  it("覆盖期 = 表中最大年份的 12-31（不是最后一条假期的日期）", () => {
    expect(holidayCoverageEnd(seedList)).toBe("2026-12-31");
    expect(holidayCoverageEnd([])).toBeNull();
  });

  it("45 天窗口 / 30 天节流", () => {
    // 今天 2026-11-20：覆盖期末日 2026-12-31 距今天 41 天 < 45 → 不足
    expect(holidayCoverageEnough("2026-12-31", "2026-11-20")).toBe(false);
    expect(holidayCoverageEnough("2026-12-31", "2026-11-01")).toBe(true);

    expect(holidayGapDue({ coverageEnd: "2026-12-31", today: "2026-11-20", lastHandledDate: null })).toBe(true);
    expect(
      holidayGapDue({ coverageEnd: "2026-12-31", today: "2026-11-20", lastHandledDate: "2026-11-10" }),
    ).toBe(false);
    expect(
      holidayGapDue({ coverageEnd: "2026-12-31", today: "2026-11-20", lastHandledDate: "2026-10-21" }),
    ).toBe(true);
  });

  it("覆盖期够用时不自检（哪怕冷却期早过了）", () => {
    expect(
      holidayGapDue({ coverageEnd: "2027-12-31", today: "2026-11-20", lastHandledDate: null }),
    ).toBe(false);
  });

  it("引用键带覆盖期版本：表补上后自动重新武装", () => {
    expect(holidayGapRefKey("2026-12-31")).toBe("coverage:2026-12-31");
    expect(holidayGapRefKey(null)).toBe("coverage:none");
    expect(holidayGapRefKey("2027-12-31")).not.toBe(holidayGapRefKey("2026-12-31"));
  });

  it("展示文案与提示条只陈述状态，没有按钮口吻", () => {
    expect(holidayCoverageText("2027-12-31")).toBe("2027 年全年");
    expect(holidayCoverageText(null)).toBe("无数据");
    const notice = holidayGapNotice("2026-12-31");
    expect(notice).toContain("2026");
    expect(notice).not.toMatch(/点击|按钮|通知助手|催/);
  });
});

describe("去重键与重锚询问（FR-36/37/38）", () => {
  it("事件按 (type, ref_key, date) 全天唯一；投递按渠道各一条", () => {
    expect(eventDedupeKey("workout", "workout", "2026-09-28")).toBe("workout|workout|2026-09-28");
    expect(deliveryDedupeKey("workout", "workout", "2026-09-28", "feishu")).not.toBe(
      deliveryDedupeKey("workout", "workout", "2026-09-28", "pwa"),
    );
    expect(reanchorRefKey(7)).toBe("proposal:7");
    expect(cheatRefKey()).toBe("cheat");
  });

  it("停练 ≥3 个训练日才问重锚", () => {
    expect(shouldProposeReanchor({ trainingDaysMissed: 2, lastRejectedAt: null, lastRecordDate: null })).toBe(false);
    expect(shouldProposeReanchor({ trainingDaysMissed: 3, lastRejectedAt: null, lastRecordDate: null })).toBe(true);
  });

  it("拒绝后本次暂停期内不再重复问；出现新训练记录后重新计数", () => {
    expect(reanchorAskSuppressed("2026-09-20", "2026-09-21")).toBe(false); // 拒绝后有新记录
    expect(reanchorAskSuppressed("2026-09-20", "2026-09-19")).toBe(true); // 拒绝后没有新记录
    expect(reanchorAskSuppressed("2026-09-20", null)).toBe(true);
    expect(
      shouldProposeReanchor({ trainingDaysMissed: 5, lastRejectedAt: "2026-09-20", lastRecordDate: "2026-09-19" }),
    ).toBe(false);
  });
});
