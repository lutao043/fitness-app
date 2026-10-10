/**
 * 动作库与器械变体的类型（需求书 6 章 / 13.1 / 13.14 / 13.15）。
 * 数据本体在 `src/data/exercises.json`（从原型一次性提取，动作名一字不改）。
 */

/** 动作的记录形态：重量×次数 / 自重次数 / 计时（FR-8） */
export type ExerciseType = "weight" | "reps" | "time";

/**
 * 重量口径（13.1）：决定"单侧读数怎么折算成总重"。
 * - barbell     杠铃：单侧 × 2 + 杠重（默认 20 kg）
 * - dumbbell    哑铃双手动作：单侧 × 2
 * - machine     器械 / 绳索：读数即总重
 * - bodyweight  自重（引体、俯卧撑、平板撑）：不计容量
 * - single_side 单臂动作：单侧 × 1（左右各做一遍算 1 组）
 */
export type LoadMode = "barbell" | "dumbbell" | "machine" | "bodyweight" | "single_side";

/** 读数语义（13.14）：决定"这个读数能不能比、算不算容量" */
export type LoadSemantics = "direct" | "ratio_2to1" | "assist" | "band";

export interface ExerciseVariantDef {
  id: string;
  equip: string;
  semantics: LoadSemantics;
  /** 备注（如「靠窗那台」「龙门架 + 下拉杆」） */
  label: string;
}

export interface ExerciseEntry {
  name: string;
  /** 细分肌群（15 项口径，13.15）：一个动作可关联多个 */
  muscles: string[];
  type: ExerciseType;
  /** 器械 = 默认变体的器械（13.14：器械是变体属性，不是名字的一部分） */
  equip: string;
  loadMode: LoadMode;
  /** 杠重 kg（仅 barbell；默认 20，动作级可改，如 EZ 杆 10） */
  barKg?: number;
  sets: number;
  reps: number;
  /** 参考起始重量（单侧口径，kg） */
  base?: number;
  homeOk?: boolean;
  note?: string;
  /** 额外的器械变体；默认变体 = 动作本身（键为裸动作名，13.14） */
  variants?: ExerciseVariantDef[];
}

/** 器械 → 默认读数语义（原型 semanticsForEquip；不确定读数口径就留 direct，13.14） */
export function semanticsForEquip(equip: string): LoadSemantics {
  if (equip === "弹力带") return "band";
  if (equip === "助力器械") return "assist";
  return "direct";
}

/** 一个动作的全部变体（含默认变体，id = null） */
export interface ResolvedVariant {
  id: string | null;
  equip: string;
  semantics: LoadSemantics;
  label: string;
}

export function defaultVariantOf(entry: ExerciseEntry): ResolvedVariant {
  return {
    id: null,
    equip: entry.equip,
    semantics: semanticsForEquip(entry.equip),
    label: "",
  };
}

export function variantsOf(entry: ExerciseEntry): ResolvedVariant[] {
  return [
    defaultVariantOf(entry),
    ...(entry.variants ?? []).map((v) => ({
      id: v.id,
      equip: v.equip,
      semantics: v.semantics ?? semanticsForEquip(v.equip),
      label: v.label,
    })),
  ];
}

export function findVariant(entry: ExerciseEntry, id?: string | null): ResolvedVariant | null {
  if (!id) return defaultVariantOf(entry);
  return variantsOf(entry).find((v) => v.id === id) ?? null;
}

/** 分组键（13.14）：「动作名」= 默认变体；「动作名|变体id」= 额外变体 */
export function variantKey(name: string, variantId?: string | null): string {
  return variantId ? `${name}|${variantId}` : name;
}

export function variantDisplayName(v: ResolvedVariant | null): string {
  if (!v) return "—";
  return v.label || v.equip;
}
