"use client";

/**
 * 动作选择器（规则管理共用）：搜索 + 按肌群筛选 + 点一下选中。
 *
 * 用在两处：槽位动作清单的「从动作库加动作」（FR-21）与开练计划页的「加动作」（FR-10）。
 * 数据由调用方传入（一次查询，两个页面共用），这里只管挑。
 */

import { useMemo, useState } from "react";
import type { ExerciseLibraryRow, SlotExerciseRow } from "@/client/api";
import { Sheet } from "@/components/ui";

/** 选中的动作（统一成调用方好用的形状：库里的行与槽位里的行字段名不同） */
export interface PickedExercise {
  id: number;
  name: string;
  type: "weight" | "reps" | "time";
  muscles: string[];
  equip: string;
  sets: number;
  reps: number;
  /** 读数口径（换动作时按新动作重算容量要用，issue #43） */
  loadMode?: string;
  barKg?: number | null;
}

function normalize(ex: ExerciseLibraryRow | SlotExerciseRow): PickedExercise {
  if ("exerciseId" in ex) {
    return {
      id: ex.exerciseId,
      name: ex.name,
      type: ex.type,
      muscles: ex.muscles,
      equip: ex.equip,
      sets: ex.targetSets,
      reps: ex.targetReps,
    };
  }
  return {
    id: ex.id,
    name: ex.name,
    type: ex.type,
    muscles: ex.muscles,
    equip: ex.equip,
    sets: ex.defaultSets,
    reps: ex.defaultReps,
  };
}

export function ExercisePicker({
  open,
  title,
  exercises,
  muscles,
  /** 优先排在前面的肌群（如"今天该练的部位"），把同肌群的替代动作摆在最前 */
  prefer = [],
  excludeIds = [],
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  exercises: (ExerciseLibraryRow | SlotExerciseRow)[];
  muscles: readonly string[];
  prefer?: readonly string[];
  excludeIds?: number[];
  onPick: (exercise: PickedExercise) => void;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [muscle, setMuscle] = useState<string | null>(null);

  const list = useMemo(() => {
    const kw = keyword.trim();
    const rows = exercises.filter((ex) => {
      if (excludeIds.includes(normalize(ex).id)) return false;
      if (muscle && !ex.muscles.includes(muscle)) return false;
      if (kw && !ex.name.includes(kw) && !ex.equip.includes(kw) && !ex.muscles.join("").includes(kw)) return false;
      return true;
    });
    const score = (ex: ExerciseLibraryRow | SlotExerciseRow) => {
      const hit = prefer.filter((p) => ex.muscles.includes(p)).length;
      return hit > 0 ? 0 : 1;
    };
    return [...rows].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, "zh"));
  }, [exercises, excludeIds, keyword, muscle, prefer]);

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <input
        className="input mb-2 h-10"
        placeholder="搜动作 / 器械 / 肌群"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          className={`tap rounded-lg border px-2.5 text-[12.5px] ${muscle === null ? "border-accent bg-accent-soft font-semibold" : "border-border"}`}
          onClick={() => setMuscle(null)}
        >
          全部
        </button>
        {prefer
          .filter((m) => muscles.includes(m))
          .map((m) => (
            <button
              key={`prefer-${m}`}
              type="button"
              className={`tap rounded-lg border px-2.5 text-[12.5px] ${
                muscle === m ? "border-accent bg-accent-soft font-semibold" : "border-border"
              }`}
              onClick={() => setMuscle(m)}
            >
              {m}
            </button>
          ))}
        {muscles
          .filter((m) => !prefer.includes(m))
          .map((m) => (
            <button
              key={m}
              type="button"
              className={`tap rounded-lg border px-2.5 text-[12.5px] ${muscle === m ? "border-accent bg-accent-soft font-semibold" : "border-border"}`}
              onClick={() => setMuscle(m)}
            >
              {m}
            </button>
          ))}
      </div>

      <div className="space-y-1.5">
        {list.length === 0 && <div className="muted py-6 text-center text-[13px]">没搜到动作</div>}
        {list.map((ex) => {
          const picked = normalize(ex);
          const target = `${picked.sets} × ${picked.reps}${picked.type === "time" ? " 秒" : ""}`;
          return (
            <button
              key={picked.id}
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-left"
              onClick={() => onPick(picked)}
            >
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{picked.name}</span>
                <span className="muted block truncate text-[11.5px]">
                  {picked.muscles.join(" + ")} · {picked.equip}
                  {picked.type === "time" ? " · 计时" : picked.type === "reps" ? " · 自重次数" : ""}
                </span>
              </span>
              <span className="muted shrink-0 text-[12px]">{target}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
