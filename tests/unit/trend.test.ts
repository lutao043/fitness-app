/**
 * FR-16 目标达成日期预估（lib/caliber/trend.ts）。
 *
 * 口径（13.2）：只用晨起序列、显式按日期比较（记录稀疏时按真实间隔算斜率，别按数组下标）。
 * 线性最小二乘的预期值都用"恰好落在一条直线上的点"构造 —— 斜率必须严格等于构造值。
 */

import { describe, expect, it } from "vitest";
import { estimateGoalEta, goalEtaText } from "@/lib/caliber/trend";
import { addDays, type DateStr } from "@/lib/time";

const TODAY = "2026-09-14";

/** 从起始日起每天 weight0 - rate*第几天，构造一条精确直线 */
function linear(start: DateStr, days: number, weight0: number, ratePerDay: number) {
  return Array.from({ length: days }, (_, i) => ({
    date: addDays(start, i),
    weightKg: Math.round((weight0 - ratePerDay * i) * 100) / 100,
  }));
}

describe("FR-16 预估达成日期（近 14 天晨起趋势）", () => {
  it("每天等间隔、精确线性下降 → 斜率 = -0.1，0.7kg 缺口 = 7 天", () => {
    const points = linear("2026-09-01", 14, 70.0, 0.1); // 09-01..09-14，70.0 → 68.7
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.direction).toBe("down");
    expect(eta.perDayKg).toBeCloseTo(-0.1, 6);
    expect(eta.daysLeft).toBe(7);
    expect(eta.etaDate).toBe("2026-09-21");
  });

  it("记录稀疏（隔几天一条）也按真实日期间隔算斜率，不按数组下标", () => {
    // 09-01/09-04/09-08/09-12/09-14，全部落在 70 - 0.1*天 的直线上
    const points = [
      { date: "2026-09-01", weightKg: 70.0 },
      { date: "2026-09-04", weightKg: 69.7 },
      { date: "2026-09-08", weightKg: 69.3 },
      { date: "2026-09-12", weightKg: 68.9 },
      { date: "2026-09-14", weightKg: 68.7 },
    ];
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.perDayKg).toBeCloseTo(-0.1, 6);
    expect(eta.daysLeft).toBe(7);
    expect(eta.etaDate).toBe("2026-09-21");
  });

  it("晨起点不足 3 个 → 不外推", () => {
    const eta = estimateGoalEta({
      today: TODAY,
      targetKg: 68,
      morning: [
        { date: "2026-09-12", weightKg: 69.0 },
        { date: "2026-09-14", weightKg: 68.8 },
      ],
    });
    expect(eta.perDayKg).toBeNull();
    expect(eta.etaDate).toBeNull();
  });

  it("点太密（跨度 < 5 天）→ 不外推，两天的水分波动不代表趋势", () => {
    const eta = estimateGoalEta({
      today: TODAY,
      targetKg: 68,
      morning: [
        { date: "2026-09-10", weightKg: 70.0 },
        { date: "2026-09-11", weightKg: 69.8 },
        { date: "2026-09-12", weightKg: 69.6 },
      ],
    });
    expect(eta.etaDate).toBeNull();
  });

  it("在涨但目标更低 → 不给日期，不编一个谎言", () => {
    const points = linear("2026-09-01", 14, 70.0, -0.05); // 反弹中
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.direction).toBe("down");
    expect(eta.etaDate).toBeNull();
    expect(eta.daysLeft).toBeNull();
  });

  it("已在目标上 → daysLeft = 0、direction none", () => {
    const points = linear("2026-09-01", 14, 68.65, 0.05); // 恰好降到 68.0
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.direction).toBe("none");
    expect(eta.daysLeft).toBe(0);
    expect(eta.etaDate).toBe(TODAY);
  });

  it("增肌向（目标更高、序列在涨）→ direction up + 正常外推", () => {
    const points = linear("2026-09-01", 14, 60.0, -0.1); // 反过来：weight0 - rate → 在涨
    const eta = estimateGoalEta({ today: TODAY, targetKg: 62.0, morning: points });
    expect(eta.direction).toBe("up");
    expect(eta.perDayKg).toBeCloseTo(0.1, 6);
    expect(eta.daysLeft).toBe(7);
  });

  it("窗口只取近 14 天：一个月前的离群点不参与斜率", () => {
    const points = [
      { date: "2026-08-25", weightKg: 75.0 }, // 窗口外的旧记录 + 暴涨值
      ...linear("2026-09-01", 14, 70.0, 0.1),
    ];
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.perDayKg).toBeCloseTo(-0.1, 6);
  });

  it("超过一年的预估不给日期（速率早会变）", () => {
    // 速率 0.01 kg/天、缺口 5kg ≈ 500 天
    const points = linear("2026-09-01", 14, 73.0, 0.01);
    const eta = estimateGoalEta({ today: TODAY, targetKg: 68.0, morning: points });
    expect(eta.direction).toBe("down");
    expect(eta.etaDate).toBeNull();
    expect(eta.daysLeft).toBeNull();
  });

  it("文案：各分支都成立，不给命令式措辞", () => {
    const done = estimateGoalEta({
      today: TODAY,
      targetKg: 68,
      morning: linear("2026-09-01", 14, 68.65, 0.05),
    });
    expect(goalEtaText(done, 68)).toContain("已在目标");
    const ok = estimateGoalEta({ today: TODAY, targetKg: 68, morning: linear("2026-09-01", 14, 70, 0.1) });
    expect(goalEtaText(ok, 68)).toContain("按当前速率约 7 天后");
    const noTrend = estimateGoalEta({
      today: TODAY,
      targetKg: 68,
      morning: linear("2026-09-01", 14, 70, -0.05),
    });
    expect(goalEtaText(noTrend, 68)).toContain("暂不外推");
    const none = estimateGoalEta({ today: TODAY, targetKg: 68, morning: [] });
    expect(goalEtaText(none, 68)).toContain("先记满");
  });
});
