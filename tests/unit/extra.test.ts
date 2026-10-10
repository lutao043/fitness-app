/**
 * 加练的循环顺延（需求书 13.17）——纯函数单测。
 *
 * 默认四天方案：循环位 0 背+二头 / 1 胸+三头 / 2 肩+腿 / 3 休（与 13.17 的例子一致）。
 * 这里用显式锚点 + 空假期表，避免被 2026 年种子的假期窗口影响；假期与顺延的交互另有用例。
 */

import { describe, expect, it } from "vitest";
import { addDays, type DateStr } from "@/lib/time";
import {
  cycleIndex,
  extraShiftSummary,
  extraTrainingPoints,
  slotIndexAt,
  slotOf,
  type CyclePoint,
  type ScheduleCtx,
} from "@/lib/schedule";
import { cycle4Slots, makeCtx } from "./helpers";

const slots = cycle4Slots();
/** 锚点 = 背+二头（循环位 0） */
const ANCHOR: DateStr = "2026-10-08";
/** 锚点后第 3 天：循环位 3「休」—— 加练就发生在这种日子 */
const REST_DAY: DateStr = "2026-10-11";
const DAY = (n: number) => addDays(ANCHOR, n);

function baseCtx(opts: { holidays?: Iterable<DateStr>; skips?: Iterable<DateStr>; points?: Iterable<CyclePoint> } = {}) {
  return makeCtx({
    anchor: { date: ANCHOR, position: 0 },
    holidays: opts.holidays ?? [],
    skips: opts.skips ?? [],
    points: opts.points ?? [],
  });
}

/** 一串日期上的部位名（断言整段排期用） */
function partsOn(ctx: ScheduleCtx, dates: DateStr[]): (string | undefined)[] {
  return dates.map((d) => slotOf(d, ctx, slots)?.label);
}

describe("循环位点（13.7 / 13.17）", () => {
  it("只影响当日及以后：当天之前的排期一个字都不改", () => {
    const ctx = baseCtx({ points: [{ date: DAY(3), position: 1 }] });
    expect(slotIndexAt(DAY(0), ctx)).toBe(0);
    expect(slotIndexAt(DAY(2), ctx)).toBe(2);
    // 从位点那天起按 position 走
    expect(slotIndexAt(DAY(3), ctx)).toBe(1);
    expect(slotIndexAt(DAY(4), ctx)).toBe(2);
  });

  it("没有位点时与锚点行为完全一致（回归：v1.19 的算法不变）", () => {
    const ctx = baseCtx();
    expect(slotIndexAt(DAY(3), ctx)).toBe(3);
    // 锚点之前：反向推算不变
    expect(cycleIndex(DAY(-3), ctx)).toBe(-3);
    expect(slotIndexAt(DAY(-3), ctx)).toBe(1);
  });

  it("同一天多条位点取最后一条", () => {
    const ctx = baseCtx({
      points: [
        { date: DAY(2), position: 0 },
        { date: DAY(2), position: 2 },
      ],
    });
    expect(slotIndexAt(DAY(2), ctx)).toBe(2);
  });

  it("位点 + 假期：假期不占循环位（与次日同位次），位点照常生效", () => {
    const ctx = baseCtx({ holidays: [DAY(4)], points: [{ date: DAY(3), position: 0 }] });
    expect(slotIndexAt(DAY(3), ctx)).toBe(0);
    // 假期当天与"假期后第一个训练日"位次相同（13.7：假期不占循环位，不推位次）
    expect(slotIndexAt(DAY(4), ctx)).toBe(1);
    expect(slotIndexAt(DAY(5), ctx)).toBe(1);
    expect(slotIndexAt(DAY(6), ctx)).toBe(2);
  });

  it("位点 + 顺延：顺延日不占循环位（次日补上同一位次）", () => {
    const ctx = baseCtx({ skips: [DAY(4)], points: [{ date: DAY(3), position: 0 }] });
    expect(slotIndexAt(DAY(4), ctx)).toBe(1);
    expect(slotIndexAt(DAY(5), ctx)).toBe(1); // 次日补上错过的部位（同位次）
    expect(slotIndexAt(DAY(6), ctx)).toBe(2);
  });
});

describe("加练的两条影响（13.17）", () => {
  it("休日加练「背+二头」：休息顺延到明天，'下一个背'被顶掉 → 后天从「胸+三头」接着排", () => {
    const before = baseCtx();
    // 加练当天仍是「休」（加练不占循环位）
    expect(slotOf(REST_DAY, before, slots)?.rest).toBe(true);

    const points = extraTrainingPoints({ date: REST_DAY, slotPosition: 0, slots, ctx: before });
    expect(points).toEqual([
      { date: DAY(4), position: 3 }, // 明天 = 今天没休的「休」
      { date: DAY(5), position: 1 }, // 原排期里"下一个背"的那天 → 从它的下一位接着排
    ]);

    const after = baseCtx({ points });
    expect(partsOn(after, [DAY(4), DAY(5), DAY(6), DAY(7), DAY(8)])).toEqual([
      "休",
      "胸+三头",
      "肩+腿",
      "休",
      "背+二头",
    ]);
  });

  it("休日加练的不是'下一位'：休息照样顺延，那一天的该部位从排期里去掉", () => {
    const before = baseCtx();
    const points = extraTrainingPoints({ date: REST_DAY, slotPosition: 2, slots, ctx: before });
    const after = baseCtx({ points });
    expect(partsOn(after, [DAY(4), DAY(5), DAY(6), DAY(7), DAY(8), DAY(9), DAY(10)])).toEqual([
      "休",
      "背+二头",
      "胸+三头",
      "休",
      "背+二头",
      "胸+三头",
      "肩+腿",
    ]);
  });

  it("假期加练：没有'休息要补'（假期本来不占循环位），只把该部位的下一次排期去掉", () => {
    const holiday = DAY(3);
    const ctx = baseCtx({ holidays: [holiday] });
    const points = extraTrainingPoints({ date: holiday, slotPosition: 0, slots, ctx });
    expect(points).toEqual([{ date: DAY(5), position: 1 }]);

    const after = baseCtx({ holidays: [holiday], points });
    expect(partsOn(after, [DAY(4), DAY(5), DAY(6)])).toEqual(["休", "胸+三头", "肩+腿"]);
  });

  it("同一次加练重复调用不会重复产出「休息顺延」那位（整单幂等在会话级 ref_session_id）", () => {
    const before = baseCtx();
    const first = extraTrainingPoints({ date: REST_DAY, slotPosition: 0, slots, ctx: before });
    const again = extraTrainingPoints({
      date: REST_DAY,
      slotPosition: 0,
      slots,
      ctx: baseCtx({ points: first }),
    });
    // 「休息顺延」那条不重复产出；但"再往下一次轮到该部位"确实存在 ——
    // 所以写入必须以会话为幂等键（`cycle_point.ref_session_id`），不能靠这个函数自己去重（13.17）
    expect(again.some((p) => p.date === DAY(4) && p.position === 3)).toBe(false);
  });

  it("加练前的排期不受影响（过去几天不许被改写）", () => {
    const before = baseCtx();
    const points = extraTrainingPoints({ date: REST_DAY, slotPosition: 0, slots, ctx: before });
    const after = baseCtx({ points });
    for (const d of [DAY(0), DAY(1), DAY(2), DAY(3)]) {
      expect(slotIndexAt(d, after)).toBe(slotIndexAt(d, before));
    }
  });
});

describe("加练后的提示（13.17）", () => {
  it("休日加练：休息顺延到哪天 + 接下来练什么", () => {
    const before = baseCtx();
    const points = extraTrainingPoints({ date: REST_DAY, slotPosition: 0, slots, ctx: before });
    const summary = extraShiftSummary({
      date: REST_DAY,
      ctx: baseCtx({ points }),
      slots,
      deferredRest: true,
    });
    expect(summary.restDate).toBe(DAY(4));
    expect(summary.nextTraining).toEqual({ date: DAY(5), label: "胸+三头" });
  });

  it("假期加练：没有顺延的休息，只说接下来练什么", () => {
    const holiday = DAY(3);
    const points = extraTrainingPoints({ date: holiday, slotPosition: 0, slots, ctx: baseCtx({ holidays: [holiday] }) });
    const summary = extraShiftSummary({
      date: holiday,
      ctx: baseCtx({ holidays: [holiday], points }),
      slots,
      deferredRest: false,
    });
    expect(summary.restDate).toBeNull();
    expect(summary.nextTraining).toEqual({ date: DAY(5), label: "胸+三头" });
  });
});
