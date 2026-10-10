/**
 * 重量与容量口径（需求书 13.1 + 13.14）—— 口径错了要洗历史数据，这里只按文档实现，不做任何"优化"。
 *
 * - 录入与展示一律是**单侧重量**（面板上写"每侧"）；库里同时留 `weight_kg`（单侧原值）与 `total_load_kg`（折算总重）。
 * - 容量（volume）一律按总重算：`Σ(total_load_kg × reps)`；计时动作不计容量。
 * - 基准例子：平板卧推 20 kg/侧 → 总重 60 kg（20×2 + 杠 20）；引体 / 助力引体 / 弹力带不计容量。
 */

import type { LoadMode, LoadSemantics } from "@/lib/exercise/types";
import { formatWeight, round1, type WeightUnit } from "@/lib/units";

export const DEFAULT_BAR_KG = 20;

export interface SetLoadInput {
  /** 面板上的单侧读数（kg）；自重 / 计时动作可为空 */
  weightKg?: number | null;
  reps?: number | null;
  loadMode: LoadMode;
  /** 杠重（仅 barbell 用；缺省 20） */
  barKg?: number | null;
  /** 变体读数语义（13.14）：缺省 direct */
  semantics?: LoadSemantics;
}

/**
 * 一组的**总重 kg**（13.1 折算 + 13.14 语义）。
 * 返回 null = 这一组不计容量（自重 / 助力 / 弹力带 / 没填重量）。
 */
export function totalLoadKg(input: SetLoadInput): number | null {
  const semantics = input.semantics ?? "direct";
  if (semantics === "assist" || semantics === "band") return null; // 助力读数越大越省力、弹力带跨次不可比

  const w = input.weightKg;
  if (w === null || w === undefined || !Number.isFinite(w) || w <= 0) return null;

  let base: number;
  switch (input.loadMode) {
    case "barbell":
      base = w * 2 + (input.barKg ?? DEFAULT_BAR_KG);
      break;
    case "dumbbell":
      base = w * 2;
      break;
    case "single_side":
      base = w; // 左右各做一遍算 1 组，一次「完成一组」记 1 条 → 不翻倍
      break;
    case "machine":
      base = w;
      break;
    case "bodyweight":
      return null;
    default:
      return null;
  }
  // 滑轮 2:1：实际负荷 = 读数 × 2（通常配绳索/器械）
  const total = semantics === "ratio_2to1" ? base * 2 : base;
  return round1(total);
}

/** 一组容量 = 总重 × 次数；不计容量的情况返回 0（组数/次数照记）。 */
export function setVolumeKg(input: SetLoadInput): number {
  const total = totalLoadKg(input);
  const reps = input.reps;
  if (total === null || reps === null || reps === undefined || reps <= 0) return 0;
  return Math.round(total * reps);
}

/** 容量永远按 kg 算完再按当前单位换算展示（交互设计说明 §1.1） */
export { round1, kgToLb, lbToKg } from "@/lib/units";

/** 统计页与训练小结必须标注口径（13.1 / 13.14） */
export const VOLUME_CALIBER_NOTE = "容量按总重计（杠铃含杠 20 kg；助力与弹力带不计容量）";

/**
 * 读数口径的**短提示**（issue #35）：变体面板一行里用（「上次 45 lb · 每侧」）。
 * 与 `weightLabel` 同一个判定，只是不带「重量（…）」外壳。
 */
export function weightReadHint(
  loadMode: LoadMode | null | undefined,
  semantics: LoadSemantics | null | undefined,
): string {
  if (semantics === "assist") return "助力读数";
  if (semantics === "band") return "弹力带";
  switch (loadMode) {
    case "barbell":
      return "每侧";
    case "dumbbell":
      return "每只";
    case "single_side":
      return "一侧";
    case "bodyweight":
      return "加重";
    default:
      return semantics === "ratio_2to1" ? "器械读数（2:1）" : "器械读数";
  }
}

/**
 * 记组卡的重量输入标签（issue #35 / v1.37）：按动作类型说人话 —— 器械 / 绳索写「每侧」本身就是错的。
 * 与 `totalLoadKg` 同源同口径（同一个 loadMode + semantics 决定"这个数是什么"）。
 */
export function weightLabel(
  loadMode: LoadMode | null | undefined,
  semantics: LoadSemantics | null | undefined,
  unit: WeightUnit,
): string {
  if (semantics === "assist") return `助力（${unit}，读数越大越省力）`;
  if (semantics === "band") return `弹力带（${unit}，跨次不可比）`;
  switch (loadMode) {
    case "barbell":
      return `重量（每侧 ${unit}）`;
    case "dumbbell":
      return `重量（每只 ${unit}）`;
    case "single_side":
      return `重量（一侧 ${unit}）`;
    case "bodyweight":
      return `加重（${unit}，可不填）`;
    default:
      // machine / 未知：面板上的数就是这台器械的读数（读数即总重，13.1）
      return `重量（${unit}，器械读数）`;
  }
}

/**
 * 重量次要区的摘要（issue #35）：默认折叠时显示的一行。
 * 没填就说"未填 · 可不填"，**不要**把「—」或上一组的重量混进来（他没填就是没填）。
 */
export function weightSummaryText(weightKg: number | null | undefined, unit: WeightUnit): string {
  if (weightKg === null || weightKg === undefined) return "未填 · 可不填";
  return `${formatWeight(weightKg, unit)} · 可不填`;
}
