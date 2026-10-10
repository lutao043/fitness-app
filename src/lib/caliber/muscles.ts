/**
 * 肌群两层口径（需求书 13.15）。
 *
 * - **细分肌群（15 项，落库口径）**：胸 / 背 / 斜方 / 下背 / 肩前束 / 肩中束 / 肩后束 / 二头 / 三头 /
 *   前臂 / 核心 / 股四头 / 腘绳 / 臀 / 小腿 —— 动作与槽位都用它标注；
 * - **大部位（11 项，仅展示映射）**：肩三束 → 「肩」，斜方、下背 → 「背」。只用于恢复度与统计的展示层，
 *   **不落库、不参与任何判定**。
 *
 * 这份常量与 `src/data/muscle-taxonomy.json`（从原型提取）互为校验，单测里断言两者一致。
 */

export const MUSCLE_FINE = [
  "胸",
  "背",
  "斜方",
  "下背",
  "肩前束",
  "肩中束",
  "肩后束",
  "二头",
  "三头",
  "前臂",
  "核心",
  "股四头",
  "腘绳",
  "臀",
  "小腿",
] as const;

export const MUSCLE_GROUPS = [
  "胸",
  "背",
  "肩",
  "二头",
  "三头",
  "前臂",
  "核心",
  "股四头",
  "腘绳",
  "臀",
  "小腿",
] as const;

export type MuscleFine = (typeof MUSCLE_FINE)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

const FINE_TO_GROUP: Record<string, MuscleGroup> = {
  肩前束: "肩",
  肩中束: "肩",
  肩后束: "肩",
  斜方: "背",
  下背: "背",
};

export function muscleGroup(muscle: string): MuscleGroup {
  return FINE_TO_GROUP[muscle] ?? (muscle as MuscleGroup);
}

/** 把动作的细分肌群解析成去重后的大部位（恢复度 / 统计用） */
export function muscleGroups(muscles: readonly string[]): MuscleGroup[] {
  const out: MuscleGroup[] = [];
  for (const m of muscles) {
    const g = muscleGroup(m);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}
