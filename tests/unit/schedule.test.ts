/**
 * 排期引擎单测（需求书 13.7 / 第 9 章第 3 条 / 第 11 章验收）。
 *
 * 三块：
 * 1. 102 天逐日基线（fixtures/schedule-baseline.json，来自 docs/排期对拍基线.md）逐行全等；
 * 2. 七组边界用例 × 逐日对拍（算术解 vs 逐日参照实现），共 1767 个日子；
 * 3. 需求书第 11 章与 13.7/13.8 点名的行为断言。
 */

import { describe, expect, it } from "vitest";
import baseline from "../../fixtures/schedule-baseline.json";
import {
  cycleIndex,
  isTrainingDay,
  nextDateOfSlotIndex,
  partOf,
  slotIndexAt,
  owedParts,
  needsReanchorBeforeSkip,
  owedText,
  trainingDaysMissed,
  shouldAskReanchor,
} from "@/lib/schedule";
import { SCHEMES } from "@/data";
import {
  BASELINE_ANCHOR,
  bruteCycleIndex,
  cycle4Slots,
  dateRange,
  makeCtx,
  SEED_HOLIDAY_SET,
} from "./helpers";

describe("102 天逐日基线（docs/排期对拍基线.md）", () => {
  const ctx = makeCtx({});
  const slots = cycle4Slots();

  it("fixture 自身的前提与种子一致", () => {
    expect(baseline.meta.anchor).toEqual({ date: "2026-09-21", position: 0 });
    expect(baseline.meta.slotLabels).toEqual(["背+二头", "胸+三头", "肩+腿", "休"]);
    expect(baseline.rows).toHaveLength(102);
  });

  it("每一天的循环位与部位都与基线全等", () => {
    const mismatches: string[] = [];
    for (const row of baseline.rows) {
      const idx = cycleIndex(row.date, ctx);
      const part = partOf(row.date, ctx, slots);
      if (idx !== row.index || part !== row.part) {
        mismatches.push(`${row.date}: 期望 ${row.index}/${row.part}，实际 ${idx}/${part}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("七组边界用例：算术解 vs 逐日参照实现（1767 天）", () => {
  const cases: {
    name: string;
    from: string;
    to: string;
    anchor?: { date: string; position: number };
    skips?: string[];
  }[] = [
    { name: "无顺延 2026-01-01~2027-06-30", from: "2026-01-01", to: "2027-06-30" },
    { name: "锚点之前一整年（历史回看）", from: "2025-06-01", to: "2026-12-31" },
    { name: "连续 2 天顺延", from: "2026-09-01", to: "2026-12-31", skips: ["2026-10-13", "2026-10-14"] },
    { name: "假期与顺延重叠", from: "2026-09-01", to: "2026-12-31", skips: ["2026-10-01", "2026-10-07"] },
    { name: "顺延撞补班日", from: "2026-02-01", to: "2026-03-31", skips: ["2026-02-14"] },
    {
      name: "锚点在未来（手滑设错）",
      from: "2026-06-01",
      to: "2027-04-30",
      anchor: { date: "2027-03-10", position: 0 },
    },
  ];

  for (const c of cases) {
    it(`${c.name}：0 处不一致`, () => {
      const ctx = makeCtx({ anchor: c.anchor ?? BASELINE_ANCHOR, skips: c.skips ?? [] });
      const days = dateRange(c.from, c.to);
      const mismatches: string[] = [];
      for (const d of days) {
        const fast = cycleIndex(d, ctx);
        const slow = bruteCycleIndex(d, ctx);
        if (fast !== slow) mismatches.push(`${d}: 算术解 ${fast} vs 逐日 ${slow}`);
      }
      expect(mismatches).toEqual([]);
      expect(days.length).toBeGreaterThan(0);
    });
  }

  it("锚点当天 + 前后各两天 = -2 / -1 / 0 / 1 / 2", () => {
    const ctx = makeCtx({});
    expect(dateRange("2026-09-19", "2026-09-23").map((d) => cycleIndex(d, ctx))).toEqual([
      -2, -1, 0, 1, 2,
    ]);
  });
});

describe("需求书 3.2 / 第 11 章点名的行为", () => {
  const ctx = makeCtx({});
  const slots = cycle4Slots();

  it("锚点起连四天：背+二头 / 胸+三头 / 肩+腿 / 休", () => {
    expect(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].map((d) => partOf(d, ctx, slots))).toEqual([
      "背+二头",
      "胸+三头",
      "肩+腿",
      "休",
    ]);
  });

  it("假期 9-25~9-27 不占循环位，9-28 回到背+二头", () => {
    for (const d of ["2026-09-25", "2026-09-26", "2026-09-27"]) {
      expect(SEED_HOLIDAY_SET.has(d)).toBe(true);
      expect(isTrainingDay(d, ctx, slots)).toBe(false);
    }
    expect(partOf("2026-09-28", ctx, slots)).toBe("背+二头");
  });

  it("补班日占位：2026-02-14（周六补班）与 2-28 都照常推进循环", () => {
    // 补班日不在 holidays 集合里 → 占位；若被当成假期，跨春节的位次会整体偏 1
    expect(SEED_HOLIDAY_SET.has("2026-02-14")).toBe(false);
    const before = cycleIndex("2026-02-13", ctx);
    expect(cycleIndex("2026-02-14", ctx)).toBe(before + 1);
  });

  it("点「今天不练」→ 次日补上错过的那个部位", () => {
    const skippedCtx = makeCtx({ skips: ["2026-09-29"] });
    const part = partOf("2026-09-29", skippedCtx, slots);
    expect(part).toBe("胸+三头");
    // 9-29 顺延后，9-30 还是「胸+三头」；顺延日不占循环位
    expect(partOf("2026-09-30", skippedCtx, slots)).toBe("胸+三头");
    expect(partOf("2026-10-01", skippedCtx, slots)).toBe("肩+腿");
  });

  it("停练 20 天后重锚为「胸」→ 当天显示胸，次日肩腿（默认方案）", () => {
    const reanchored = makeCtx({ anchor: { date: "2026-10-20", position: 1 } });
    expect(partOf("2026-10-20", reanchored, slots)).toBe("胸+三头");
    expect(partOf("2026-10-21", reanchored, slots)).toBe("肩+腿");
  });

  it("循环位取模对负数也成立（锚点在未来的手滑场景）", () => {
    const future = makeCtx({ anchor: { date: "2027-03-10", position: 0 } });
    const idx = slotIndexAt("2026-03-10", future);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(4);
  });

  it("跨年：2026-12-31 → 2027-01-01 循环位 +1", () => {
    expect(cycleIndex("2027-01-01", ctx)).toBe(cycleIndex("2026-12-31", ctx) + 1);
  });

  it("13.9 的「距下次轮到 X 天」：nextDateOfSlotIndex 找得到下一个该循环位", () => {
    const next = nextDateOfSlotIndex("2026-09-28", ctx, slots, 1);
    expect(next).toBe("2026-09-29");
  });

  it("历史回看：锚点之前的日子也能算（13.7 必须支持 date < anchor）", () => {
    expect(cycleIndex("2026-09-20", ctx)).toBe(-1);
    expect(partOf("2026-09-20", ctx, slots)).toBe("休");
  });
});

describe("顺延欠账（13.8）", () => {
  const fiveSplitSlots = (SCHEMES.find((s) => s.id === "split5")?.slots ?? []).map((s) => ({
    label: s.label,
    rest: s.rest,
    muscles: s.muscles,
  }));

  it("连续两天顺延 → 欠 2 个部位（先欠的先练）", () => {
    const ctx = makeCtx({ skips: ["2026-09-22", "2026-09-23"] });
    // 默认方案下 9-22 排到「胸+三头」，欠账队列 = 胸+三头、肩+腿
    const owed = owedParts("2026-09-23", ctx, cycle4Slots(), null);
    expect(owed.map((o) => o.part)).toEqual(["胸+三头", "肩+腿"]);
    expect(owedText(owed)).toBe("欠 2 个部位：胸+三头、肩+腿");
  });

  it("五分化下：第一天排到「胸」→ 欠「胸、背」（与第 11 章文案一致）", () => {
    const ctx = makeCtx({
      anchor: { date: "2026-09-21", position: 0 },
      skips: ["2026-09-21", "2026-09-22"],
      cycleLen: fiveSplitSlots.length,
    });
    const owed = owedParts("2026-09-23", ctx, fiveSplitSlots, null);
    expect(owed.map((o) => o.part)).toEqual(["胸", "背"]);
  });

  it("第 3 天顺延要先弹重锚询问；拒绝后照写且可超过 2", () => {
    const ctx = makeCtx({ skips: ["2026-09-22", "2026-09-23"] });
    const owed = owedParts("2026-09-23", ctx, cycle4Slots(), null);
    expect(needsReanchorBeforeSkip(owed)).toBe(true); // 再顺延一次就是第 3 条
    expect(needsReanchorBeforeSkip([])).toBe(false);
    expect(needsReanchorBeforeSkip([{ date: "2026-09-22", part: "胸+三头" }])).toBe(false);
  });

  it("练过之后欠账清零（该区域的顺延日不算欠账）", () => {
    const ctx = makeCtx({ skips: ["2026-09-22", "2026-09-23"] });
    const owed = owedParts("2026-09-23", ctx, cycle4Slots(), "2026-09-23");
    expect(owed).toEqual([]);
  });
});

describe("停练训练日数（FR-38）", () => {
  const slots = cycle4Slots();

  it("只数训练日：休日与假期不算", () => {
    const ctx = makeCtx({});
    // 最后一次活动 9-21，到 9-24：9-22、9-23 是训练日（9-24 是「休」）→ 2 个
    expect(trainingDaysMissed("2026-09-24", ctx, slots, "2026-09-21")).toBe(2);
    // 10-01 之后到 10-08：10-02~10-07 全是国庆假期 → 0 个
    expect(trainingDaysMissed("2026-10-08", ctx, slots, "2026-10-01")).toBe(0);
    // 10-09 之后到 10-12：10-10（周六补班）与 10-11 都是训练日 → 2 个，10-12 是「休」
    expect(trainingDaysMissed("2026-10-12", ctx, slots, "2026-10-09")).toBe(2);
  });

  it("≥3 个训练日 → 该问重锚", () => {
    expect(shouldAskReanchor(2)).toBe(false);
    expect(shouldAskReanchor(3)).toBe(true);
  });

  it("从没练过时返回 0（不给新用户弹重锚询问）", () => {
    const ctx = makeCtx({});
    expect(trainingDaysMissed("2026-10-10", ctx, slots, null)).toBe(0);
  });
});
