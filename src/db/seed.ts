/**
 * 种子注入（开发计划 §3 / 需求书 13.12）。
 *
 * 规则：
 * - **只注入一次**：用 `app_meta` 的 `seed.v1` 标记守住。不能实现成"表为空就补种子" ——
 *   那样把假期表清空后一刷新就长回来，"表过期"这个状态根本存不住（13.12 明确点过这个坑）；
 * - 假期种子只当**首次安装的初始值**（`source = "seed"`），此后助手经 PUT /api/v1/holidays 整年覆盖；
 * - 演示数据（原型里的训练 / 体重）**不迁移**（第 12 章第 18 条：老数据不导入，空库起）。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { EXERCISES, HOLIDAY_SEED_2026, SCHEMES, DEFAULT_SCHEME_ID } from "@/data";
import type { ExerciseEntry } from "@/lib/exercise/types";
import { dateInTz } from "@/lib/time";
import { HOLIDAY_META_SOURCE_KEY, HOLIDAY_META_UPDATED_AT_KEY } from "./holidays";
import * as schema from "./schema";

type Db = BetterSQLite3Database<typeof schema>;

/** 默认锚点：与 docs/排期对拍基线.md 的前提一致（并行期要跟助手逐日对拍） */
export const INITIAL_ANCHOR_DATE = "2026-09-21";

export const SEED_FLAG_KEY = "seed.v1";
export const HOLIDAYS_SEEDED_KEY = "holidays.seeded";

export function isSeeded(db: Db): boolean {
  const row = db.select().from(schema.appMeta).all().find((r) => r.key === SEED_FLAG_KEY);
  return !!row;
}

export function seedOnce(db: Db, installedAt: Date = new Date()): { seeded: boolean } {
  const existing = db.select().from(schema.appMeta).all();
  if (existing.some((r) => r.key === SEED_FLAG_KEY)) return { seeded: false };

  const installedDate = dateInTz(installedAt);
  const isoNow = installedAt.toISOString();

  db.transaction((tx) => {
    // —— 用户与设置 ——
    tx.insert(schema.user)
      .values({ nickname: "我", heightCm: 170, targetWeightKg: 70 })
      .run();

    const settings: [string, string][] = [
      ["unit", "kg"],
      ["reminder_time", "22:30"],
      ["workout_reminder_on", "true"],
      ["rest_default_sec", "90"],
    ];
    for (const [key, value] of settings) {
      tx.insert(schema.appSetting).values({ key, value }).run();
    }

    // —— 分化方案（5 套）+ 槽位 ——
    // 槽位的动作清单（cycle_exercise）在动作库插好之后由 seedSchemeExercises() 补齐。
    SCHEMES.forEach((scheme, schemeIndex) => {
      tx.insert(schema.splitScheme)
        .values({
          id: scheme.id,
          name: scheme.name,
          note: scheme.note,
          orderNo: schemeIndex,
          active: scheme.id === DEFAULT_SCHEME_ID,
        })
        .run();

      scheme.slots.forEach((slot, slotIndex) => {
        tx.insert(schema.cycleTemplate)
          .values({
            schemeId: scheme.id,
            position: slotIndex,
            name: slot.label,
            isRest: !!slot.rest,
            muscles: slot.muscles ?? [],
          })
          .run();
      });
    });

    // —— 动作库（114 条）+ 器械变体 ——
    EXERCISES.forEach((entry, index) => {
      const inserted = tx
        .insert(schema.exercise)
        .values(exerciseRow(entry, index))
        .returning({ id: schema.exercise.id })
        .get();

      variantRows(inserted.id, entry).forEach((row) => {
        tx.insert(schema.exerciseVariant).values(row).run();
      });
    });

    // —— 锚点（每方案一条链；默认方案与对拍基线一致）——
    for (const scheme of SCHEMES) {
      tx.insert(schema.scheduleAnchor)
        .values({
          schemeId: scheme.id,
          anchorDate: INITIAL_ANCHOR_DATE,
          cyclePosition: 0,
          reason: "initial",
          note: "首次安装的初始锚点",
        })
        .run();
    }

    // —— 假期表种子：只当首次安装的初始值，只注入一次（13.12）——
    for (const [date, day] of Object.entries(HOLIDAY_SEED_2026)) {
      tx.insert(schema.holiday)
        .values({ date, name: day.name, type: day.type, updatedAt: isoNow, source: "seed" })
        .run();
    }
    tx.insert(schema.appMeta).values({ key: HOLIDAYS_SEEDED_KEY, value: "1" }).run();
    // 元信息一并落 app_meta（设置页「最近更新于 X · 来源 Y」读这两个键）
    tx.insert(schema.appMeta)
      .values({ key: HOLIDAY_META_UPDATED_AT_KEY, value: isoNow })
      .onConflictDoUpdate({ target: schema.appMeta.key, set: { value: isoNow } })
      .run();
    tx.insert(schema.appMeta)
      .values({ key: HOLIDAY_META_SOURCE_KEY, value: "seed" })
      .onConflictDoUpdate({ target: schema.appMeta.key, set: { value: "seed" } })
      .run();

    // —— 补剂（原型种子：D3 / 磷虾油 / 锌镁片 / 维 C）——
    const supplements = [
      { name: "维生素 D3", times: ["09:30"], doseText: "1 粒 · 早餐随餐" },
      { name: "磷虾油", times: ["13:30"], doseText: "1 粒 · 午餐随餐" },
      { name: "锌镁片", times: ["22:30"], doseText: "1 片 · 睡前，勿与 D3 同服" },
      { name: "维 C", times: ["12:00"], doseText: "1 片 · 随手" },
    ];
    supplements.forEach((s, index) => {
      tx.insert(schema.supplement)
        .values({ ...s, orderNo: index, enabled: true })
        .run();
    });

    // —— 放纵餐：8 天一轮，锚点 = 安装当天（用户报"吃了"时把锚点挪到那天）——
    tx.insert(schema.cheatSetting)
      .values({ intervalDays: 8, anchorDate: installedDate })
      .run();

    tx.insert(schema.appMeta).values({ key: SEED_FLAG_KEY, value: isoNow }).run();
  });

  seedSchemeExercises(db);
  return { seeded: true };
}

/* ———————————————— 内置动作库：种子映射 + 已有安装的「补齐」入口 ———————————————— */

/**
 * 动作种子 → `exercise` 行（种子注入与「补齐内置动作库」共用一份映射，别各写一份 —— 两份迟早写歪）。
 * `orderNo` 用种子里的下标：新加的动作永远排在库尾，已有库补齐时也不会打乱原有顺序。
 */
function exerciseRow(entry: ExerciseEntry, orderNo: number) {
  return {
    name: entry.name,
    muscles: entry.muscles,
    type: entry.type,
    equip: entry.equip,
    loadMode: entry.loadMode,
    barKg: entry.barKg ?? null,
    defaultSets: entry.sets,
    defaultReps: entry.reps,
    baseWeight: entry.base ?? null,
    homeOk: !!entry.homeOk,
    note: entry.note ?? null,
    orderNo,
  };
}

/** 动作种子自带的器械变体 → `exercise_variant` 行（默认变体 = 动作本身，不在这里） */
function variantRows(exerciseId: number, entry: ExerciseEntry) {
  return (entry.variants ?? []).map((variant, index) => ({
    exerciseId,
    code: variant.id,
    equip: variant.equip,
    loadSemantics: variant.semantics,
    label: variant.label ?? "",
    orderNo: index,
  }));
}

/** 内置库里这台设备还没有的动作名（按种子顺序）——「补齐」的预览，不改库 */
export function missingBuiltinExercises(db: Db): string[] {
  const existing = new Set(
    db.select({ name: schema.exercise.name }).from(schema.exercise).all().map((r) => r.name),
  );
  return EXERCISES.filter((e) => !existing.has(e.name)).map((e) => e.name);
}

/**
 * 把内置动作库里**缺失的**动作补进库（按名字比对）。
 *
 * - **只新增、不修改、不删除**：已有的动作（哪怕改过参数、改过名）一个字都不动 ——
 *   所以它跟「种子只注入一次」（13.12）不冲突：库扩充后，已装过的设备靠这个入口补上；
 * - 幂等：补完再调 = 0 个新增；
 * - 已知边界：把某个动作**改过名**的话，内置名会被当成缺失再补一份（预览里能看到，删掉多余那份即可）；
 *   已有动作的**器械变体**不会被追补（只补整条动作）。
 */
export function syncBuiltinExerciseLibrary(db: Db): { added: string[]; kept: number; total: number } {
  const existing = new Set(
    db.select({ name: schema.exercise.name }).from(schema.exercise).all().map((r) => r.name),
  );
  const missing = EXERCISES.map((entry, index) => ({ entry, index })).filter(
    ({ entry }) => !existing.has(entry.name),
  );
  if (missing.length === 0) return { added: [], kept: existing.size, total: EXERCISES.length };

  db.transaction((tx) => {
    for (const { entry, index } of missing) {
      const inserted = tx
        .insert(schema.exercise)
        .values(exerciseRow(entry, index))
        .returning({ id: schema.exercise.id })
        .get();
      variantRows(inserted.id, entry).forEach((row) => {
        tx.insert(schema.exerciseVariant).values(row).run();
      });
    }
  });
  return { added: missing.map(({ entry }) => entry.name), kept: existing.size, total: EXERCISES.length };
}

/**
 * 槽位动作清单：动作库插好之后按名字解析成 exercise_id 写入 cycle_exercise。
 * 单独一步是为了先建动作库再引用（避免在同一个事务里查自己刚插的表）。
 */
function seedSchemeExercises(db: Db): void {
  const exercises = db.select({ id: schema.exercise.id, name: schema.exercise.name }).from(schema.exercise).all();
  const idByName = new Map(exercises.map((e) => [e.name, e.id]));
  const templates = db
    .select({ id: schema.cycleTemplate.id, schemeId: schema.cycleTemplate.schemeId, position: schema.cycleTemplate.position })
    .from(schema.cycleTemplate)
    .all();

  db.transaction((tx) => {
    for (const scheme of SCHEMES) {
      scheme.slots.forEach((slot, slotIndex) => {
        const template = templates.find((t) => t.schemeId === scheme.id && t.position === slotIndex);
        if (!template) return;
        const add = (mode: "gym" | "home", list: typeof slot.ex) => {
          list.forEach((entry, order) => {
            const exerciseId = idByName.get(entry.name);
            if (!exerciseId) throw new Error(`槽位引用了动作库里没有的动作：${entry.name}`);
            tx.insert(schema.cycleExercise)
              .values({
                templateId: template.id,
                mode,
                exerciseId,
                orderNo: order,
                targetSets: entry.sets,
                targetReps: entry.reps,
              })
              .run();
          });
        };
        add("gym", slot.ex);
        add("home", slot.homeEx);
      });
    }
  });
}
