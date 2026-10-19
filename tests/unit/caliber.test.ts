/**
 * 口径库单测（需求书 13.1 / 13.2 相关折算 / 13.5 / 13.6 / 13.9 / 3.4）。
 */

import { describe, expect, it } from "vitest";
import {
  attendanceStats,
  muscleGroup,
  muscleGroups,
  MUSCLE_FINE,
  MUSCLE_GROUPS,
  restBeforeSec,
  restStats,
  streak,
  recoveryState,
  recoveryThresholdsFor,
  setVolumeKg,
  totalLoadKg,
  VOLUME_CALIBER_NOTE,
} from "@/lib/caliber";
import { cheatDaysSince, cheatNext, isWorkingDay } from "@/lib/caliber/cheat";
import { isTrainingDay, slotOf } from "@/lib/schedule";
import { SCHEMES, TAXONOMY, EXERCISES } from "@/data";
import { makeCtx, cycle4Slots, SEED_MAKEUP_SET, SEED_HOLIDAY_SET } from "./helpers";

describe("13.1 / 13.14 重量与容量折算", () => {
  it("平板卧推 20 kg/侧 → 总重 60（含杠 20）", () => {
    expect(totalLoadKg({ weightKg: 20, loadMode: "barbell" })).toBe(60);
    expect(setVolumeKg({ weightKg: 20, reps: 12, loadMode: "barbell" })).toBe(720);
  });

  it("哑铃双手动作 = 单侧 × 2", () => {
    expect(totalLoadKg({ weightKg: 10, loadMode: "dumbbell" })).toBe(20);
  });

  it("器械 / 绳索读数即总重，不做滑轮比换算", () => {
    expect(totalLoadKg({ weightKg: 50, loadMode: "machine" })).toBe(50);
  });

  it("单臂动作 = 单侧 × 1（左右各做一遍算 1 组，13.1）", () => {
    expect(totalLoadKg({ weightKg: 20, loadMode: "single_side" })).toBe(20);
    expect(setVolumeKg({ weightKg: 20, reps: 10, loadMode: "single_side" })).toBe(200);
  });

  it("自重动作不计容量（只计组数与次数）", () => {
    expect(totalLoadKg({ weightKg: 0, loadMode: "bodyweight" })).toBeNull();
    expect(setVolumeKg({ reps: 8, loadMode: "bodyweight" })).toBe(0);
  });

  it("滑轮 2:1：读数 25 → 实际负荷 50", () => {
    expect(totalLoadKg({ weightKg: 25, loadMode: "machine", semantics: "ratio_2to1" })).toBe(50);
    expect(
      setVolumeKg({ weightKg: 25, reps: 10, loadMode: "machine", semantics: "ratio_2to1" }),
    ).toBe(500);
  });

  it("助力引体（assist）：组数照记、容量为 0，读数越大越省力", () => {
    expect(totalLoadKg({ weightKg: 40, loadMode: "bodyweight", semantics: "assist" })).toBeNull();
    expect(setVolumeKg({ weightKg: 40, reps: 8, loadMode: "bodyweight", semantics: "assist" })).toBe(0);
  });

  it("弹力带（band）：跨次不可比、不进容量", () => {
    expect(totalLoadKg({ weightKg: 15, loadMode: "machine", semantics: "band" })).toBeNull();
  });

  it("EZ 杆等动作级杠重可改（默认 20）", () => {
    expect(totalLoadKg({ weightKg: 15, loadMode: "barbell", barKg: 10 })).toBe(40);
  });

  it("统计口径文案存在且点明杠重与不计容量的两类", () => {
    expect(VOLUME_CALIBER_NOTE).toContain("总重");
    expect(VOLUME_CALIBER_NOTE).toContain("助力");
    expect(VOLUME_CALIBER_NOTE).toContain("弹力带");
  });
});

describe("13.15 肌群两层口径", () => {
  it("细分 15 项 → 大部位 11 项（肩三束合并、斜方/下背并入背）", () => {
    expect(MUSCLE_FINE).toHaveLength(15);
    expect(MUSCLE_GROUPS).toHaveLength(11);
    expect(muscleGroup("肩前束")).toBe("肩");
    expect(muscleGroup("肩中束")).toBe("肩");
    expect(muscleGroup("肩后束")).toBe("肩");
    expect(muscleGroup("斜方")).toBe("背");
    expect(muscleGroup("下背")).toBe("背");
    expect(muscleGroup("股四头")).toBe("股四头");
  });

  it("一个动作可关联多块肌群（卧推 = 胸 + 三头 + 肩前束）", () => {
    expect(muscleGroups(["胸", "三头", "肩前束"])).toEqual(["胸", "三头", "肩"]);
  });

  it("口径常量与提取出的种子数据一致（防漂移）", () => {
    expect(TAXONOMY.fine).toEqual([...MUSCLE_FINE]);
    expect(TAXONOMY.groups).toEqual([...MUSCLE_GROUPS]);
    expect(TAXONOMY.fineToGroup["斜方"]).toBe("背");
  });
});

describe("13.5 组间歇与换项间隔", () => {
  const ex = (exercise: string, variantId: string | null = null) => ({ exercise, variantId });

  it("第一组没有 rest_before_sec", () => {
    const r = restBeforeSec({ prevDoneAt: null, startedAt: 1000, prev: null, current: ex("卧推") });
    expect(r.restBeforeSec).toBeNull();
    expect(r.sameExercise).toBe(false);
  });

  it("暂停 60s、前后各活跃 3s → 记 6s（只扣一次，不是 -54s、也不是 8s）", () => {
    const t0 = 1_000_000;
    const r = restBeforeSec({
      prevDoneAt: t0,
      startedAt: t0 + 3_000 + 60_000 + 3_000,
      pausedMsBetween: 60_000,
      prev: ex("卧推"),
      current: ex("卧推"),
    });
    expect(r.restBeforeSec).toBe(6);
    expect(r.sameExercise).toBe(true);
  });

  it("换动作 / 换器械变体 → sameExercise = false", () => {
    expect(
      restBeforeSec({ prevDoneAt: 0, startedAt: 90_000, prev: ex("卧推"), current: ex("高位下拉") })
        .sameExercise,
    ).toBe(false);
    expect(
      restBeforeSec({
        prevDoneAt: 0,
        startedAt: 90_000,
        prev: ex("高位下拉", null),
        current: ex("高位下拉", "v-cable"),
      }).sameExercise,
    ).toBe(false);
    expect(
      restBeforeSec({
        prevDoneAt: 0,
        startedAt: 90_000,
        prev: ex("高位下拉", "v-cable"),
        current: ex("高位下拉", "v-cable"),
      }).sameExercise,
    ).toBe(true);
  });

  it("负数间隔（时钟异常）不写库", () => {
    expect(restBeforeSec({ prevDoneAt: 10_000, startedAt: 5_000, prev: ex("卧推"), current: ex("卧推") }).restBeforeSec).toBeNull();
  });

  it("没有开始时刻（忘点开始 / 老数据）= 没有真实间隔 → null，不退回「完成 − 完成」（13.5 v1.50）", () => {
    const r = restBeforeSec({ prevDoneAt: 1_000_000, startedAt: null, prev: ex("卧推"), current: ex("卧推") });
    expect(r.restBeforeSec).toBeNull();
    // same_exercise 与时间无关，照常判定（历史行的展示要靠它）
    expect(r.sameExercise).toBe(true);
  });

  it("算的是「上一组完成 → 本组开始」：本组自身的做组耗时不算进休息（issue #75 的线上偏大）", () => {
    // 上一组 0s 完成 → 歇 90s → 本组 90s 开始做、做了 40s、130s 记下
    const r = restBeforeSec({ prevDoneAt: 0, startedAt: 90_000, prev: ex("卧推"), current: ex("卧推") });
    expect(r.restBeforeSec).toBe(90); // 旧调用方传 done_at（130s）= 把 40s 做组耗时算进休息
  });

  it("组间歇均值只算同动作，换项间隔单列（13.5）", () => {
    const stats = restStats([
      { restBeforeSec: 90, sameExercise: true },
      { restBeforeSec: 100, sameExercise: true },
      { restBeforeSec: 200, sameExercise: false },
      { restBeforeSec: null, sameExercise: true }, // 每个动作的第一组
    ]);
    expect(stats.sameExerciseAvgSec).toBe(95);
    expect(stats.changeoverAvgSec).toBe(200);
    expect(stats.sameExerciseCount).toBe(2);
    expect(stats.changeoverCount).toBe(1);
  });
});

describe("13.4 出勤率（记录页统计卡）", () => {
  // 三槽位小循环：推 / 拉 / 休，锚点 9-21 位次 0 → 9-21 推、9-22 拉、9-23 休、9-24 推
  const slots = [{ label: "推" }, { label: "拉" }, { label: "休", rest: true }];
  const ctx = {
    anchor: { date: "2026-09-21", position: 0 },
    holidays: new Set<string>(),
    skips: new Set<string>(),
    cycleLen: 3,
  };

  it("分母扣休日；分子 = 训练∪打卡（休日练了也算出勤）", () => {
    const attended = new Set(["2026-09-22", "2026-09-23"]);
    // 窗口 09-21..09-24：推、拉、休、推 → 计划日 3；出勤 2（其中 9-23 是休日）
    expect(attendanceStats("2026-09-24", 4, ctx, slots, attended)).toEqual({
      plannedDays: 3,
      attendedDays: 2,
    });
  });

  it("法定节假日不算计划日（分母扣除；假期不占循环位，次日回到同一槽位）", () => {
    const ctxHol = { ...ctx, holidays: new Set(["2026-09-22"]) };
    // 窗口 09-21..09-23：推（计划）、9-22 假期（扣）、9-23 回到推（计划）→ 分母 2
    expect(attendanceStats("2026-09-23", 3, ctxHol, slots, new Set())).toEqual({
      plannedDays: 2,
      attendedDays: 0,
    });
  });
});

describe("13.6 streak：断签只按训练日判定", () => {
  const ctx = makeCtx({});
  const slots = cycle4Slots();
  const run = (today: string, records: string[]) =>
    streak({ today, ctx, slots, hasRecord: (d) => records.includes(d) });

  it("连续训练日都有记录 → 计数；今天没记录不算断签", () => {
    // 9-21(一) 背、9-22(二) 胸、9-23(三) 肩腿、9-24(四) 休
    expect(run("2026-09-22", ["2026-09-21", "2026-09-22"])).toBe(2);
    expect(run("2026-09-24", ["2026-09-21", "2026-09-22", "2026-09-23"])).toBe(3);
  });

  it("休日与法定节假日既不要求也不断签", () => {
    // 9-24 是「休」、9-25~27 是中秋假期；9-28 有记录 → streak = 4（21/22/23/28）
    expect(run("2026-09-28", ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-28"])).toBe(4);
  });

  it("训练日无记录且未顺延 → 断（前面练过的天数不再计入）", () => {
    // 9-23 是训练日没记录 → 从 9-24 往回看，走到 9-23 就断了；9-21/9-22 不算进"连续"
    expect(run("2026-09-24", ["2026-09-21", "2026-09-22"])).toBe(0);
  });

  it("当天已顺延 → 不断签也不计为记录日", () => {
    // 9-22 顺延（那天是「胸+三头」），9-21 与 9-23 都有记录：
    // 9-24 往回：9-24 是训练日但今天还没记录（不算断）→ 9-23 有记录（1）→ 9-22 已顺延（跳过、不计）→ 9-21 有记录（2）
    const skippedCtx = makeCtx({ skips: ["2026-09-22"] });
    const value = streak({
      today: "2026-09-24",
      ctx: skippedCtx,
      slots,
      hasRecord: (d) => ["2026-09-21", "2026-09-23"].includes(d),
    });
    expect(value).toBe(2);
  });

  it("打卡（workout）算有记录 —— 由调用方把 checkin 并进 hasRecord", () => {
    expect(run("2026-09-24", ["2026-09-21", "2026-09-22", "2026-09-23"])).toBe(3);
  });

  it("今天早上打开（还没记录）不会看到清零", () => {
    expect(run("2026-09-23", ["2026-09-21", "2026-09-22"])).toBe(2);
    expect(run("2026-09-23", [])).toBe(0);
  });
});

describe("13.9 恢复度：阈值随循环长度参数化", () => {
  it("四天循环 = 48h / 72h（与旧口径一致）", () => {
    expect(recoveryThresholdsFor(4)).toEqual({ alertHours: 48, recoveredHours: 72 });
  });

  it("三天 / 五天分化跟着变，不写死 48/72", () => {
    expect(recoveryThresholdsFor(3)).toEqual({ alertHours: 36, recoveredHours: 54 });
    expect(recoveryThresholdsFor(5)).toEqual({ alertHours: 60, recoveredHours: 90 });
  });

  it("三段状态：恢复中 / 基本恢复 / 已恢复", () => {
    const now = Date.parse("2026-09-28T20:00:00+08:00");
    const hoursAgo = (h: number) => now - h * 3_600_000;
    expect(recoveryState(hoursAgo(10), now, 4).label).toBe("恢复中");
    expect(recoveryState(hoursAgo(50), now, 4).label).toBe("基本恢复");
    expect(recoveryState(hoursAgo(100), now, 4).label).toBe("已恢复");
  });

  it("无记录显示「无记录」，不假装已恢复", () => {
    const r = recoveryState(null, Date.now(), 4);
    expect(r.key).toBe("none");
    expect(r.label).toBe("无记录");
    expect(r.hoursSince).toBeNull();
  });

  it("起点是实际结束时间：上午 10:00 练完，当天 20:00 显示约 10 小时", () => {
    const endedAt = Date.parse("2026-09-28T10:00:00+08:00");
    const now = Date.parse("2026-09-28T20:00:00+08:00");
    expect(recoveryState(endedAt, now, 4).hoursSince).toBe(10);
  });
});

describe("3.4 放纵餐：撞上班日顺延、补班日不算周末", () => {
  const ctx = makeCtx({});
  const slots = cycle4Slots();
  const opts = {
    isHoliday: (d: string) => SEED_HOLIDAY_SET.has(d),
    isMakeupWorkday: (d: string) => SEED_MAKEUP_SET.has(d),
  };
  const isTraining = (d: string) => isTrainingDay(d, ctx, slots);
  const next = (anchorDate: string, today: string, intervalDays = 8) =>
    cheatNext({ anchorDate, intervalDays, today, ...opts, isTrainingDay: isTraining });

  it("间隔 8 天：8 天后就是这个候选日（不是上班日时不动）", () => {
    // 2026-09-24(四) + 8 = 10-02(五)，国庆假期 → 非上班日 → 直接落在 10-02
    expect(next("2026-09-24", "2026-09-25")).toBe("2026-10-02");
  });

  it("撞上班日 → 顺延到之后最近的休息日（含法定假期）", () => {
    // 2026-09-21(一) + 8 = 9-29(二) 上班日 → 9-30 上班日 → 10-01 国庆假期：非上班日 → 落 10-01
    expect(next("2026-09-21", "2026-09-22")).toBe("2026-10-01");
    // 换成 9-28(一) + 8 = 10-06（国庆假期内）→ 直接落在 10-06，仍是"非上班日"
    expect(next("2026-09-28", "2026-09-28")).toBe("2026-10-06");
  });

  it("补班日（10-10）算上班日：不会被当成周末挑中", () => {
    const d = "2026-10-10";
    expect(isWorkingDay(d, opts)).toBe(true);
  });

  it("周末两天都要训练 → 优先换到另一天", () => {
    // 构造一个人造 scheme 检测：用真实 9-26/9-27（中秋假期，非训练日）不适用，
    // 这里直接用周六 11-07/周日 11-08：11-07 训练日、11-08 也是训练日 → 换不了 → 留在 11-07
    const d1 = next("2026-10-30", "2026-10-30");
    expect(d1).toBe("2026-11-07");
    expect(isTraining(d1)).toBe(true); // 两天都要训练 → 饭照吃、训练顺延
  });

  it("锚点长期没更新 → 先按间隔往前追平，不返回过去的日期", () => {
    const d = next("2026-01-01", "2026-09-25");
    expect(d >= "2026-09-25").toBe(true);
  });

  it("距上次 N 天（首页展示）", () => {
    expect(cheatDaysSince("2026-09-20", "2026-09-25")).toBe(5);
  });
});

describe("种子数据自检", () => {
  it("默认方案四个槽位与原口径一致", () => {
    const scheme = SCHEMES.find((s) => s.id === "cycle4");
    expect(scheme?.slots.map((s) => s.label)).toEqual(["背+二头", "胸+三头", "肩+腿", "休"]);
  });

  /**
   * 动作库自检（v1.22 扩充到 114 条）：条数、名字唯一、肌群与器械都在词表里、重量类必须有参考起始重量。
   * **条数是有意写死的** —— 库扩充时改这一条，顺带逼着把文档里的数字一起改。
   */
  it("动作库：114 条、名字唯一、肌群 / 器械都在词表里", () => {
    expect(EXERCISES).toHaveLength(114);
    expect(new Set(EXERCISES.map((e) => e.name)).size).toBe(EXERCISES.length);
    for (const e of EXERCISES) {
      expect(e.muscles.length, e.name).toBeGreaterThan(0);
      for (const m of e.muscles) expect(TAXONOMY.fine, `${e.name} → ${m}`).toContain(m);
      expect(TAXONOMY.equips, `${e.name} → ${e.equip}`).toContain(e.equip);
      if (e.type === "weight") expect(typeof e.base, `${e.name} 缺参考起始重量`).toBe("number");
      if (e.loadMode === "barbell") expect(e.barKg, `${e.name} 缺杠重`).toBe(20);
    }
  });

  it("肩腿日：先肩 4 个动作（肩推 + 前/中/后束各 1），再腿 2 个", () => {
    const scheme = SCHEMES.find((s) => s.id === "cycle4");
    const slot = scheme?.slots.find((s) => s.label === "肩+腿");
    expect(slot?.ex.slice(0, 4).map((e) => e.name)).toEqual(["坐姿肩推", "侧平举", "反向飞鸟", "前平举"]);
    expect(slot?.ex.slice(4).map((e) => e.name)).toEqual(["高脚杯深蹲", "罗马尼亚硬拉"]);
  });

  /**
   * 默认四天循环的动作配比（需求书 3.1，用户 2026-10-08 定的）：
   * **主要部位 4 个动作 / 手臂各 1 个 / 腿 2 个**；健身房与居家两套都按这个形状。
   * 居家受动作库限制（家里做不了那么多胸部动作），胸只能给到 2 个 —— 这是已知且接受的偏差。
   */
  it("默认四天循环的动作配比：主要 4 / 手臂 1 / 腿 2", () => {
    const scheme = SCHEMES.find((s) => s.id === "cycle4");
    const names = (label: string, mode: "ex" | "homeEx") =>
      (scheme?.slots.find((s) => s.label === label)?.[mode] ?? []).map((e) => e.name);

    // 背+二头：背 4 + 二头 1
    expect(names("背+二头", "ex")).toEqual(["引体向上", "高位下拉", "坐姿划船", "杠铃划船", "哑铃弯举"]);
    expect(names("背+二头", "homeEx")).toEqual([
      "引体向上",
      "弹力带划船",
      "哑铃单臂划船",
      "弹力带下拉",
      "弹力带弯举",
    ]);
    // 胸+三头：胸 4（含双杠臂屈伸这个复合）+ 三头 1
    expect(names("胸+三头", "ex")).toEqual(["平板卧推", "上斜哑铃卧推", "双杠臂屈伸", "器械夹胸", "绳索下压"]);
    // 居家：胸 2 + 三头 1（家里只有俯卧撑类，凑不出 4 个胸）
    expect(names("胸+三头", "homeEx")).toEqual(["俯卧撑", "上斜俯卧撑", "凳上反屈伸"]);
    // 肩+腿：肩 4 + 腿 2（健身房与居家同形）
    expect(names("肩+腿", "ex")).toEqual([
      "坐姿肩推",
      "侧平举",
      "反向飞鸟",
      "前平举",
      "高脚杯深蹲",
      "罗马尼亚硬拉",
    ]);
    expect(names("肩+腿", "homeEx")).toEqual([
      "哑铃肩推",
      "侧平举",
      "前平举",
      "俯身飞鸟",
      "保加利亚分腿蹲",
      "臀桥",
    ]);
  });

  it("slotOf 返回槽位对象（含 muscles），休日 rest = true", () => {
    const ctx = makeCtx({});
    const slots = cycle4Slots();
    expect(slotOf("2026-09-24", ctx, slots)?.rest).toBe(true);
    expect(slotOf("2026-09-23", ctx, slots)?.muscles).toContain("股四头");
  });
});
