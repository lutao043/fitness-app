/**
 * 训练页组数表述（issue #37 / v1.36）：三处"组数"必须不同形、且做满后不再出现「第 N 组」。
 */

import { describe, expect, it } from "vitest";
import { completeSetLabel, exerciseSetText, overallSetText, shouldFinish } from "@/lib/session-progress";

describe("组数表述（issue #37）", () => {
  it("全场进度明确说「整份清单」，不写成和动作卡同形的分数", () => {
    expect(overallSetText(4, 16)).toBe("已完成 4 组，共 16 组");
    expect(overallSetText(0, 16)).toBe("已完成 0 组，共 16 组");
    expect(overallSetText(4, 16)).not.toContain("/");
  });

  it("本动作：未做满给「第 N 组 · 共 M 组」，第几组只在这里出现", () => {
    expect(exerciseSetText(0, 4)).toBe("第 1 组 · 共 4 组");
    expect(exerciseSetText(2, 4)).toBe("第 3 组 · 共 4 组");
    expect(exerciseSetText(3, 4)).toBe("第 4 组 · 共 4 组");
  });

  it("做满之后不再出现「第 M/M 组」（验收 3）", () => {
    expect(exerciseSetText(4, 4)).toBe("本动作 4 组已完成");
    expect(exerciseSetText(4, 4)).not.toContain("第 5");
    expect(exerciseSetText(5, 4)).toBe("本动作 4 组已完成"); // 多做的组也不说"第 6 组"
  });

  it("收工态：「再练一组」时改说「再加一组」（issue #39）", () => {
    expect(exerciseSetText(4, 4)).toBe("本动作 4 组已完成");
    expect(exerciseSetText(4, 4, { extraSet: true })).toBe("再加一组 · 本动作已做满 4 组");
    // 没做满时 extraSet 不影响（还是"第 N 组"）
    expect(exerciseSetText(2, 4, { extraSet: true })).toBe("第 3 组 · 共 4 组");
  });

  it("收工态判定（shouldFinish）：都做满 / 清单为空 → 收工态；点过「再练一组」压掉它（issue #39）", () => {
    expect(shouldFinish([])).toBe(true); // 清单为空（动作都被移出）
    expect(shouldFinish([{ doneSets: 4, targetSets: 4 }])).toBe(true);
    expect(
      shouldFinish([
        { doneSets: 4, targetSets: 4 },
        { doneSets: 3, targetSets: 3 },
      ]),
    ).toBe(true);
    expect(
      shouldFinish([
        { doneSets: 4, targetSets: 4 },
        { doneSets: 2, targetSets: 3 },
      ]),
    ).toBe(false); // 还有一个动作没做满 → 继续记组
    expect(shouldFinish([{ doneSets: 4, targetSets: 3 }])).toBe(true); // 多做的那组也算"做满"
    expect(shouldFinish([{ doneSets: 4, targetSets: 4 }], { extraSet: true })).toBe(false);
  });

  it("按钮文案四态：做满 / 落库中 / 刚落库 / 可点（issue #34 的防连点窗口一起钉住）", () => {
    expect(completeSetLabel({ exerciseDone: false, pending: false, justRecorded: false })).toBe("✓ 完成一组");
    expect(completeSetLabel({ exerciseDone: false, pending: true, justRecorded: false })).toBe("记下中…");
    expect(completeSetLabel({ exerciseDone: false, pending: false, justRecorded: true })).toBe("已记下 ✓");
    // 做满优先：即使上一组刚记下（justRecorded 还在窗口里），也直接给收口语
    expect(completeSetLabel({ exerciseDone: true, pending: false, justRecorded: true })).toBe("本动作已做满 · 可以收工了");
  });
});
