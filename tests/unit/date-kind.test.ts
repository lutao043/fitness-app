/**
 * 日期态（需求书 13.21 / v1.49 / issue #70）的纯函数单测：
 * 四种态（工作日 / 调休上班日 / 周末 / 法定节假日）、时间档映射、补剂适用日过滤。
 *
 * 口径来源：issue #70 §六（助手侧 `scripts/datekind.py` 的同一张表）+ 需求书 13.21。
 */

import { describe, expect, it } from "vitest";
import {
  dateKind,
  dateKindLabel,
  dayKindApplies,
  isWorkdayKind,
  reminderTimeForKind,
  supplementDayKindLabel,
  type DateKind,
} from "@/lib/reminder/date-kind";
import { decideSupplement } from "@/lib/reminder/supplements";

const ALL_KINDS: DateKind[] = ["workday", "makeup", "weekend", "holiday"];

describe("dateKind：四种态（13.21）", () => {
  it("工作日：周一~周五且假期表无记录", () => {
    expect(dateKind("2026-10-12", null)).toBe("workday"); // 周一
    expect(dateKind("2026-09-25", null)).toBe("workday"); // 周五
  });

  it("周末：周六 / 周日且无补班记录", () => {
    expect(dateKind("2026-09-26", null)).toBe("weekend"); // 周六
    expect(dateKind("2026-10-11", null)).toBe("weekend"); // 周日
  });

  it("调休上班日：周末但假期表 type=workday（调休真正落地的地方）", () => {
    expect(dateKind("2026-10-10", "workday")).toBe("makeup"); // 周六 · 国庆补班
    expect(dateKind("2026-02-14", "workday")).toBe("makeup"); // 周六 · 春节补班
  });

  it("法定节假日：type=holiday，落在周末也是 holiday（优先于 weekend）", () => {
    expect(dateKind("2026-10-01", "holiday")).toBe("holiday"); // 周四 · 国庆
    expect(dateKind("2026-01-03", "holiday")).toBe("holiday"); // 周六 · 元旦假期第三天
  });

  it("假期表优先于星期：同一周末，有 workday 记录 = makeup、有 holiday 记录 = holiday", () => {
    expect(dateKind("2026-10-10", "workday")).toBe("makeup");
    expect(dateKind("2026-10-11", "holiday")).toBe("holiday");
    expect(dateKind("2026-10-11", null)).toBe("weekend");
  });
});

describe("训练提醒时间分档映射（13.21）", () => {
  const times = { workday: "22:30", restday: "20:00" };

  it("工作日与调休上班日走工作日档", () => {
    expect(reminderTimeForKind("workday", times)).toBe("22:30");
    expect(reminderTimeForKind("makeup", times)).toBe("22:30");
  });

  it("周末与法定节假日走休息日档", () => {
    expect(reminderTimeForKind("weekend", times)).toBe("20:00");
    expect(reminderTimeForKind("holiday", times)).toBe("20:00");
  });

  it("两档默认同值（22:30）时，分档与否结果一致 —— 默认不改变行为", () => {
    const same = { workday: "22:30", restday: "22:30" };
    for (const k of ALL_KINDS) expect(reminderTimeForKind(k, same)).toBe("22:30");
  });

  it("isWorkdayKind：工作日类 = 工作日 + 调休上班日", () => {
    expect(isWorkdayKind("workday")).toBe(true);
    expect(isWorkdayKind("makeup")).toBe(true);
    expect(isWorkdayKind("weekend")).toBe(false);
    expect(isWorkdayKind("holiday")).toBe(false);
  });
});

describe("补剂适用日过滤（13.21）", () => {
  it("daily：四种态都适用（默认 = 分档前行为）", () => {
    for (const k of ALL_KINDS) expect(dayKindApplies("daily", k)).toBe(true);
  });

  it("workday：工作日 + 调休上班日适用；周末 / 法定节假日不适用", () => {
    expect(dayKindApplies("workday", "workday")).toBe(true);
    expect(dayKindApplies("workday", "makeup")).toBe(true);
    expect(dayKindApplies("workday", "weekend")).toBe(false);
    expect(dayKindApplies("workday", "holiday")).toBe(false);
  });

  it("restday：周末 + 法定节假日适用；工作日 / 调休上班日不适用", () => {
    expect(dayKindApplies("restday", "weekend")).toBe(true);
    expect(dayKindApplies("restday", "holiday")).toBe(true);
    expect(dayKindApplies("restday", "workday")).toBe(false);
    expect(dayKindApplies("restday", "makeup")).toBe(false);
  });
});

describe("decideSupplement：适用日判据（13.10 第 2 条并列分支里的一条）", () => {
  const base = {
    supplementId: 1,
    name: "D3",
    times: ["09:30"],
    takenToday: false,
    eventAlreadyGenerated: false,
    at: "23:00",
  };

  it("适用日不成立 → 不提，原因 off_day（即便已过时点）", () => {
    expect(decideSupplement({ ...base, appliesToday: false })).toEqual({
      due: false,
      dueTime: null,
      reason: "off_day",
    });
  });

  it("不传 appliesToday（老调用方 / daily）→ 行为与分档前逐字一致", () => {
    expect(decideSupplement(base)).toEqual({ due: true, dueTime: "09:30", reason: "due" });
    expect(decideSupplement({ ...base, appliesToday: true })).toEqual({
      due: true,
      dueTime: "09:30",
      reason: "due",
    });
  });

  it("适用日成立了仍按原链走：已打卡 → taken、没到点 → not_yet", () => {
    expect(decideSupplement({ ...base, appliesToday: true, takenToday: true }).reason).toBe("taken");
    expect(decideSupplement({ ...base, appliesToday: true, at: "08:00" }).reason).toBe("not_yet");
  });
});

describe("展示文案", () => {
  it("日期态标签", () => {
    expect(dateKindLabel("workday")).toBe("工作日");
    expect(dateKindLabel("makeup")).toBe("调休上班日");
    expect(dateKindLabel("weekend")).toBe("周末");
    expect(dateKindLabel("holiday")).toBe("法定节假日");
  });

  it("补剂适用日标签", () => {
    expect(supplementDayKindLabel("daily")).toBe("每天");
    expect(supplementDayKindLabel("workday")).toBe("仅工作日");
    expect(supplementDayKindLabel("restday")).toBe("仅休息日");
  });
});
