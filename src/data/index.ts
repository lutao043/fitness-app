/**
 * 种子数据入口。数据本体是 `scripts/extract-seeds.mjs` 从冻结的原型里一次性提取的 JSON
 * （开发计划 §3：动作名一字不改），这里只做类型收口。
 *
 * 注意：这些是**服务端**数据（种子、动作库），不要 import 进客户端组件里，
 * 客户端需要时由 API 下发或由服务端组件传给 props。
 */

import exercisesJson from "./exercises.json";
import schemesJson from "./schemes.json";
import holidaySeedJson from "./holiday-seed-2026.json";
import taxonomyJson from "./muscle-taxonomy.json";
import defaultsJson from "./defaults.json";
import type { ExerciseEntry } from "@/lib/exercise/types";
import type { DateStr } from "@/lib/time";

export interface SchemeExerciseSeed {
  name: string;
  sets: number;
  reps: number;
}

export interface SchemeSlotSeed {
  id: string;
  label: string;
  rest?: boolean;
  muscles: string[];
  /** 健身房清单 */
  ex: SchemeExerciseSeed[];
  /** 居家自重清单（各自独立可编辑） */
  homeEx: SchemeExerciseSeed[];
}

export interface SchemeSeed {
  id: string;
  name: string;
  note: string;
  slots: SchemeSlotSeed[];
}

export type HolidayType = "holiday" | "workday";

export interface HolidaySeedDay {
  name: string;
  type: HolidayType;
}

export const EXERCISES = exercisesJson as ExerciseEntry[];
export const SCHEMES = schemesJson as SchemeSeed[];
export const HOLIDAY_SEED_2026 = holidaySeedJson as Record<DateStr, HolidaySeedDay>;
export const DEFAULT_SCHEME_ID = (defaultsJson as { defaultSchemeId: string }).defaultSchemeId;

export const TAXONOMY = taxonomyJson as {
  fine: string[];
  groups: string[];
  fineToGroup: Record<string, string>;
  equips: string[];
  semanticsOrder: string[];
  legacyNameRenames: Record<string, string>;
  legacyMuscle: Record<string, string>;
};

/**
 * 在**种子常量**里按名字找动作（安装 / 补齐内置动作库时用）。
 *
 * ⚠️ 与 `db/writes` 的 `exerciseByName(db, name)` **不是同一个东西**（issue #32 记下的同名对）：
 * 这个查的是 `src/data` 里的常量库，那个查的是**库里的行**（判重名用）。别把两者并成一个 ——
 * 查常量永远不会知道用户自己加过什么。
 */
export function exerciseByName(name: string): ExerciseEntry | null {
  return EXERCISES.find((e) => e.name === name) ?? null;
}
