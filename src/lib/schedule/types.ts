/**
 * 排期引擎的纯函数契约（需求书 13.7）。
 *
 * 输入全部由参数传入：锚点、假期表、顺延表、循环长度 —— 不读数据库、不读全局状态，
 * 这是"排期引擎必须脱离数据库单测"（需求书第 9 章第 3 条）成立的前提。
 */

import type { DateStr } from "@/lib/time";

/** 分化方案里的一个槽位（循环位上的一天）。`rest` 为真 = 「休」日。 */
export interface SlotLike {
  label: string;
  rest?: boolean;
  /** 该槽位覆盖的细分肌群（槽位编辑用；排期本身不读它） */
  muscles?: readonly string[];
}

export interface ScheduleAnchor {
  /** 锚点日：循环位 position 落在这一天 */
  date: DateStr;
  /** 锚点日对应的循环位次（不取模的原始值，重锚时一般给 0） */
  position: number;
}

/**
 * 循环位点（13.17）：**从这一天起**循环位为 `position`，之后按占位日逐日推进。
 *
 * 与锚点的区别：锚点影响**全部日期**（历史也按它反推，重锚就是追加一条锚点）；
 * 位点**只影响该日及以后** —— 之前的日子仍按锚点 / 更早的位点算。
 * 加练的顺延走位点：**"今天加练"不许回头改写前几天显示的排期**（追加锚点会连过去一起改，所以不用它）。
 */
export interface CyclePoint {
  date: DateStr;
  position: number;
}

export interface ScheduleCtx {
  anchor: ScheduleAnchor;
  /**
   * 法定节假日集合 —— **只放 `type = "holiday"` 的日子**。
   * 补班日（`type = "workday"`）是上班日、占循环位，不能放进来（13.7 的坑）。
   */
  holidays: ReadonlySet<DateStr>;
  /** 顺延日集合（skip_day）：顺延日不占循环位，次日补上错过的部位 */
  skips: ReadonlySet<DateStr>;
  /** 循环长度 = 当前分化方案的槽位数（默认方案为 4） */
  cycleLen: number;
  /**
   * 循环位点（可选；空 = 只有锚点，行为与 v1.19 完全一致）。
   * 同一天多条取**最后一条**；没命中就退回锚点（13.17）。
   */
  points?: readonly CyclePoint[];
}
