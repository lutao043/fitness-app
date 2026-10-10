/**
 * 展示层单位换算（需求书第 12 章第 7 条 / 交互设计说明 §1.1）。
 *
 * 口径：
 * - 数据层**一律按 kg / cm 存储**，这里只做展示层换算，绝不写回库；
 * - 只有**训练重量与体重**跟着设置切 lb；围度固定 cm、体脂固定 %；
 * - 重量展示保留 1 位小数；**容量先按 kg 算完再换算**，取整（不是把 kg 的取整结果换单位）；
 * - 录入时先把输入换算回 kg 再提交 —— 库里永远是 kg。
 */

export type WeightUnit = "kg" | "lb";

/** 1 kg = 2.2046226 lb（与原型一致；只在展示层用得到） */
export const LB_PER_KG = 2.2046226;

/** 设置值 → 单位（脏值一律退回 kg） */
export function asWeightUnit(value: unknown): WeightUnit {
  return value === "lb" ? "lb" : "kg";
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}

/** kg → 展示值（1 位小数）；null/非有限值原样返回 null */
export function kgToDisplay(kg: number | null | undefined, unit: WeightUnit): number | null {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) return null;
  return round1(unit === "lb" ? kgToLb(kg) : kg);
}

/**
 * 展示值 → kg；入库前用，保证库里统一是 kg。
 *
 * 精度（v1.38 / issue #36）：kg 侧保留 1 位小数；**lb 侧保留 2 位小数** ——
 * 1 位会让非 5 倍数的铭牌来回抖（33 lb → 15.0 kg → 33.1 lb，见 issue #36 待拍板第 3 点）。
 */
export function displayToKg(value: number | null | undefined, unit: WeightUnit): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return unit === "lb" ? round2(lbToKg(value)) : round1(value);
}

/**
 * 「生效读数单位」（v1.38 / issue #36 / 13.1 展示层）：**这台器械该按什么单位读数**。
 * - 变体上配了就用变体上的（如「靠窗那台按磅标」）；
 * - 没配（老数据全是 null）= 跟随全局设置。
 *
 * **汇总（总容量 / 统计 / 趋势 / 记录页容量 / 导出）永远跟全局设置**，不跟变体 ——
 * 各台不同单位加总没有意义；导出（JSON / CSV）永远是 kg（13.13）。唯一真相在这里。
 */
export function effectiveReadUnit(
  variantUnit: WeightUnit | null | undefined,
  globalUnit: WeightUnit,
): WeightUnit {
  return variantUnit === "kg" || variantUnit === "lb" ? variantUnit : globalUnit;
}

/** 脏值 → 变体读数单位（null 也是合法值 = 跟随全局） */
export function asOptionalReadUnit(value: unknown): WeightUnit | null {
  return value === "kg" || value === "lb" ? value : null;
}

/** 容量：kg 算完再换算展示，取整（交互设计说明 §1.1） */
export function volumeToDisplay(kg: number | null | undefined, unit: WeightUnit): number {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) return 0;
  return Math.round(unit === "lb" ? kgToLb(kg) : kg);
}

/**
 * 容量文案（issue #35 / v1.37）：**没有一点重量数据时给「—」，不显示 `0 kg`** ——
 * 自重 / 只记次数的那些训练，容量本来就不适用，"0 kg"会被读成"练了个零"。
 * 数字本身仍按 §1.1：kg 算完再换算、取整。
 */
export function volumeText(kg: number | null | undefined, unit: WeightUnit): string {
  if (kg === null || kg === undefined || !Number.isFinite(kg) || kg <= 0) return "—";
  return `${volumeToDisplay(kg, unit)}`;
}

/**
 * 重量加减器的步进：kg 2.5 / lb 5（原型同款）。
 * 单位是"展示/输入"的挡位，换算到 kg 入库后仍是 1 位小数。
 */
export function weightStep(unit: WeightUnit): number {
  return unit === "lb" ? 5 : 2.5;
}

/**
 * 单侧重量的展示区间上限：kg 400（服务端读数校验同档）。
 * lb 取「400 kg 的展示值」而不是 400×2.204…，否则贴上限输入会换算回 400.1 kg 被服务端拒掉。
 */
export function weightMax(unit: WeightUnit): number {
  return unit === "lb" ? round1(kgToLb(400)) : 400;
}

/** 「20 kg」/「44.1 lb」；无值给「—」 */
export function formatWeight(kg: number | null | undefined, unit: WeightUnit): string {
  const display = kgToDisplay(kg, unit);
  return display === null ? "—" : `${display} ${unit}`;
}
