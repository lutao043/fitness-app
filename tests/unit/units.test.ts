/**
 * 展示层单位换算（需求书第 12 章第 7 条 / 交互设计说明 §1.1）。
 *
 * 这几条是"口径"级别：库里永远 kg，切 lb 只影响展示与录入；
 * 容量必须**先按 kg 算完再换算**（不是把 kg 的取整结果换单位）。
 */

import { describe, expect, it } from "vitest";
import {
  asWeightUnit,
  displayToKg,
  formatWeight,
  kgToDisplay,
  kgToLb,
  LB_PER_KG,
  lbToKg,
  volumeToDisplay,
  weightMax,
  weightStep,
} from "@/lib/units";

describe("单位换算（§1.1）", () => {
  it("1 kg = 2.2046226 lb；lb 入库保留 2 位小数（v1.38），kg→lb→kg 误差 ≤ 0.01", () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046226, 6);
    expect(lbToKg(2.2046226)).toBeCloseTo(1, 6);
    expect(displayToKg(kgToDisplay(20, "lb"), "lb")).toBe(20);
    // lb 侧 2 位小数（issue #36 待拍板第 3 点）：让「按磅铭牌读数」往返稳定；
    // 代价是 kg→lb→kg 允许 0.01 的舍入（2.5 kg → 5.5 lb → 2.49 kg），展示层看不出差别
    expect(displayToKg(kgToDisplay(2.5, "lb"), "lb")).toBe(2.49);
    expect(Math.abs(displayToKg(kgToDisplay(2.5, "lb"), "lb")! - 2.5)).toBeLessThanOrEqual(0.01);
    expect(displayToKg(45, "lb")).toBe(20.41);
    expect(kgToDisplay(20.41, "lb")).toBe(45);
  });

  it("kg 下展示值就是原值（1 位小数），lb 下按比例放大", () => {
    expect(kgToDisplay(20, "kg")).toBe(20);
    expect(kgToDisplay(20, "lb")).toBe(44.1);
    expect(kgToDisplay(60, "lb")).toBe(132.3);
    expect(kgToDisplay(null, "lb")).toBeNull();
  });

  it("容量先按 kg 算完再换算，取整（不是把 kg 的整数换单位）", () => {
    // 1000 kg → 2204.6 lb → 2205（若先四舍五入 kg 再换算也是 2205；关键是别把磅值再取整成 kg 味）
    expect(volumeToDisplay(1000, "lb")).toBe(2205);
    expect(volumeToDisplay(1000, "kg")).toBe(1000);
    expect(volumeToDisplay(1234, "kg")).toBe(1234);
    expect(volumeToDisplay(null, "lb")).toBe(0);
  });

  it("步进与上限跟着单位走：kg 2.5 / lb 5；上限与读数校验同档", () => {
    expect(weightStep("kg")).toBe(2.5);
    expect(weightStep("lb")).toBe(5);
    expect(weightMax("kg")).toBe(400);
    // 贴上限输入也不能被服务端的 0~400 校验拒掉：lb 上限是「400 kg 的展示值」
    expect(weightMax("lb")).toBe(881.8);
    // 贴上限输入也不能被服务端的 0~400 校验拒掉（2 位小数舍入后是 399.98 ≤ 400）
    expect(displayToKg(weightMax("lb"), "lb")).toBeLessThanOrEqual(400);
    expect(displayToKg(weightMax("lb"), "lb")).toBeCloseTo(400, 1);
  });

  it("脏设置值一律退回 kg（不让展示层拿到第三种单位）", () => {
    expect(asWeightUnit("lb")).toBe("lb");
    expect(asWeightUnit("kg")).toBe("kg");
    expect(asWeightUnit(undefined)).toBe("kg");
    expect(asWeightUnit("LB")).toBe("kg");
  });

  it("formatWeight 无值给「—」，有值带单位", () => {
    expect(formatWeight(20, "kg")).toBe("20 kg");
    expect(formatWeight(20, "lb")).toBe("44.1 lb");
    expect(formatWeight(null, "kg")).toBe("—");
    expect(LB_PER_KG).toBe(2.2046226);
  });
});
