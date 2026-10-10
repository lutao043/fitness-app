/**
 * 训练页两态与暂停语义（issue #33 / v1.39）。
 *
 * 关键断言（issue 的验收 3/4/5 与补充里的暂停断言）：
 * - 态由绝对时间戳判定，冷启动 / 锁屏回来结果一致；
 * - 暂停 → 数字冻住；继续 → **从暂停那一刻的剩余接着走**（不是重启、不是归零）；
 * - 跳过 = 终止（不是重来）。
 */

import { describe, expect, it } from "vitest";
import {
  pauseRest,
  restRemainingSec,
  resumeRest,
  sessionPhase,
  stopRest,
  type RestState,
} from "@/lib/session-rest";

const NOW = 1_700_000_000_000; // 固定"现在"，避免依赖真实时钟

describe("两态判定（sessionPhase）", () => {
  it("没有倒计时 → 记组态", () => {
    expect(sessionPhase({ restEnd: null, restRemainMs: null }, NOW)).toBe("record");
    expect(sessionPhase({}, NOW)).toBe("record");
  });

  it("终点在未来 → 倒计时态；已过（归零）→ 记组态", () => {
    expect(sessionPhase({ restEnd: NOW + 40_000, restRemainMs: null }, NOW)).toBe("rest");
    expect(sessionPhase({ restEnd: NOW - 1, restRemainMs: null }, NOW)).toBe("record");
    expect(sessionPhase({ restEnd: NOW, restRemainMs: null }, NOW)).toBe("record");
  });

  it("暂停中仍是倒计时态（数字冻住，不跳回记组）", () => {
    expect(sessionPhase({ restEnd: null, restRemainMs: 40_000 }, NOW)).toBe("rest");
  });

  it("锁屏 3 分钟回来：剩余量按时间戳算，不是从头数（验收 4）", () => {
    const restEnd = NOW + 90_000;
    expect(restRemainingSec({ restEnd, restRemainMs: null }, NOW)).toBe(90);
    expect(restRemainingSec({ restEnd, restRemainMs: null }, NOW + 30_000)).toBe(60);
    expect(restRemainingSec({ restEnd, restRemainMs: null }, NOW + 120_000)).toBe(0); // 已过 → 记组态
  });
});

describe("暂停 / 继续（FR-42 + issue #33 补充）", () => {
  it("暂停 = 冻结剩余量：restEnd 清空、restRemainMs 接住，数字不动", () => {
    const restEnd = NOW + 40_000;
    const paused: RestState = { ...pauseRest({ restEnd, restRemainMs: null }, NOW) };
    expect(paused.restEnd).toBeNull();
    expect(paused.restRemainMs).toBe(40_000);
    // 等 30 秒再看：还是 40 秒（冻结期间不流逝）
    expect(restRemainingSec(paused, NOW + 30_000)).toBe(40);
    expect(sessionPhase(paused, NOW + 30_000)).toBe("rest");
  });

  it("继续 = 按冻结的剩余量重算终点：从 40 秒接着走（不是 90 秒重来、也不是归零）", () => {
    const paused: RestState = { restEnd: null, restRemainMs: 40_000 };
    const resumed = resumeRest(paused, NOW + 30_000);
    expect(resumed.restEnd).toBe(NOW + 70_000); // 30 秒那一刻 + 剩下的 40 秒
    expect(resumed.restRemainMs).toBeNull();
    expect(restRemainingSec(resumed, NOW + 30_000)).toBe(40);
    expect(restRemainingSec(resumed, NOW + 50_000)).toBe(20);
    expect(sessionPhase(resumed, NOW + 30_000)).toBe("rest");
  });

  it("反复暂停 / 继续不会把剩余量吃掉", () => {
    let state: RestState = { restEnd: NOW + 60_000, restRemainMs: null };
    state = { ...pauseRest(state, NOW + 10_000) }; // 剩 50
    state = { ...resumeRest(state, NOW + 25_000) }; // 25 秒那一刻 + 50 = 75
    expect(state.restEnd).toBe(NOW + 75_000);
    state = { ...pauseRest(state, NOW + 35_000) }; // 又过 10 秒 → 剩 40
    expect(state.restRemainMs).toBe(40_000);
    state = { ...resumeRest(state, NOW + 60_000) };
    expect(restRemainingSec(state, NOW + 60_000)).toBe(40);
  });

  it("没在倒计时里点继续：什么也不做（不给一个凭空的终点）", () => {
    expect(resumeRest({ restEnd: null, restRemainMs: null }, NOW)).toEqual({
      restEnd: null,
      restRemainMs: null,
    });
  });

  it("跳过 = 终止（不是重启）：两个字段都清掉（验收 2）", () => {
    expect(stopRest()).toEqual({ restEnd: null, restRemainMs: null });
    expect(sessionPhase(stopRest(), NOW)).toBe("record");
  });
});
