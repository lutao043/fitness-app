/**
 * 训练页三态与暂停语义（issue #33 / v1.39 两态；issue #75 / v1.50 加"进行中"）。
 *
 * 关键断言（issue #75 / #77 的验收 1–3 与补充里的暂停断言）：
 * - 态由绝对时间戳判定，冷启动 / 锁屏回来结果一致；
 * - 进行中：有开始时刻且未结束，秒数按时间戳续；超 2 小时自动回待开始；
 * - 暂停 → 数字冻住；继续 → **从暂停那一刻的剩余接着走**（不是重启、不是归零）；
 * - 跳过 = 终止（不是重来）。
 */

import { describe, expect, it } from "vitest";
import {
  DOING_TIMEOUT_MS,
  doingElapsedSec,
  pauseRest,
  restRemainingSec,
  resumeRest,
  sessionPhase,
  startDoing,
  stopRest,
  type RestState,
} from "@/lib/session-rest";

const NOW = 1_700_000_000_000; // 固定"现在"，避免依赖真实时钟

describe("三态判定（sessionPhase）", () => {
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

  it("跳过 = 终止（不是重启）：字段都清掉（验收 2）", () => {
    expect(stopRest()).toEqual({ restEnd: null, restRemainMs: null, setStartedAt: null });
    const afterSkip = { ...stopRest() };
    expect(sessionPhase(afterSkip, NOW)).toBe("record");
    expect(doingElapsedSec(afterSkip, NOW)).toBe(0);
  });
});

describe("进行中态（issue #75 / v1.50）", () => {
  it("点【开始这组】= 记下绝对开始时刻 → 进行中态，不出现倒计时", () => {
    const state: RestState = { restEnd: null, restRemainMs: null, ...startDoing(NOW) };
    expect(sessionPhase(state, NOW)).toBe("doing");
    expect(sessionPhase(state, NOW + 5_000)).toBe("doing");
    expect(restRemainingSec(state, NOW + 5_000)).toBe(0); // 进行中不是倒计时
  });

  it("锁屏 3 分钟回来：秒数按时间戳续（≈180s），不归零、不重置（验收 2）", () => {
    const state = { ...startDoing(NOW) };
    expect(doingElapsedSec(state, NOW + 180_000)).toBe(180);
    expect(sessionPhase(state, NOW + 180_000)).toBe("doing");
    // 时钟回拨（now 早于开始）不显示负数，按待开始兜底
    expect(doingElapsedSec(state, NOW - 1_000)).toBe(0);
    expect(sessionPhase(state, NOW - 1_000)).toBe("record");
  });

  it("没有开始时刻 = 待开始（老 localStorage 里没有这个字段）", () => {
    expect(sessionPhase({}, NOW)).toBe("record");
    expect(sessionPhase({ restEnd: null, restRemainMs: null }, NOW)).toBe("record");
    expect(doingElapsedSec({}, NOW)).toBe(0);
  });

  it("挂太久（> 2 小时）= 僵尸态：自动回待开始，这一组不落库（需求 2 的异常收口）", () => {
    const state = { ...startDoing(NOW) };
    expect(sessionPhase(state, NOW + DOING_TIMEOUT_MS - 1)).toBe("doing");
    expect(sessionPhase(state, NOW + DOING_TIMEOUT_MS)).toBe("record");
  });

  it("休息态优先于进行中（两个字段同时有值时的兜底顺序）", () => {
    const state: RestState = { restEnd: NOW + 10_000, restRemainMs: null, setStartedAt: NOW - 5_000 };
    expect(sessionPhase(state, NOW)).toBe("rest");
  });
});
