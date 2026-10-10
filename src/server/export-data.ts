/**
 * 导出的共用序列化（13.13）：JSON（export.json）与 CSV（export.csv）从这里取同一份数据，
 * 保证"导出的范围与口径只有一套" —— 以后加字段只改这里。
 *
 * 单位与口径（13.13）：kg；weight_kg 是面板上的单侧读数；total_load_kg 是折算后的总重（13.1/13.14）。
 * 凭据材料（密码 / API token 哈希）不随行（BUG-4 回归）。
 */

import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { VOLUME_CALIBER_NOTE } from "@/lib/caliber";
import { dateInTz } from "@/lib/time";

export interface ExportPayload {
  exportedAt: string;
  exportedDate: string;
  caliber: Record<string, string>;
  user: unknown[];
  sessions: unknown[];
  sessionExercises: unknown[];
  sets: unknown[];
  bodyMetrics: unknown[];
  measurements: unknown[];
  bodyAnalyses: unknown[];
  cardioLogs: unknown[];
  [key: string]: unknown;
}

export function collectExport(db: Db): ExportPayload {
  return {
    exportedAt: new Date().toISOString(),
    exportedDate: dateInTz(),
    caliber: {
      weight: "weight_kg 是面板上的单侧读数；total_load_kg 是按 load_mode / 变体语义折算的总重",
      volume: VOLUME_CALIBER_NOTE,
      timezone: "Asia/Shanghai",
    },
    // FR-46 导出的是训练记录与身体数据 —— 凭据材料（密码 / API token 哈希）不随行
    user: db
      .select({
        id: schema.user.id,
        nickname: schema.user.nickname,
        heightCm: schema.user.heightCm,
        targetWeightKg: schema.user.targetWeightKg,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .all(),
    schemes: db.select().from(schema.splitScheme).all(),
    cycleTemplates: db.select().from(schema.cycleTemplate).all(),
    cycleExercises: db.select().from(schema.cycleExercise).all(),
    exercises: db.select().from(schema.exercise).all(),
    exerciseVariants: db.select().from(schema.exerciseVariant).all(),
    anchors: db.select().from(schema.scheduleAnchor).all(),
    skipDays: db.select().from(schema.skipDay).all(),
    holidays: db.select().from(schema.holiday).all(),
    overtimes: db.select().from(schema.overtime).all(),
    sessions: db.select().from(schema.workoutSession).all(),
    sessionExercises: db.select().from(schema.sessionExercise).all(),
    sets: db.select().from(schema.setLog).all(),
    bodyMetrics: db.select().from(schema.bodyMetric).all(),
    measurements: db.select().from(schema.measurement).all(),
    // 每日体重分析（FR-57 / v1.29）：助手写的解读也算身体数据，导出要全（13.13 的口径：导出 = 全量）
    bodyAnalyses: db.select().from(schema.bodyAnalysis).all(),
    // 有氧（FR-50 / v1.16）：独立第三类记录，不进容量也不算出勤，但导出要全
    cardioLogs: db.select().from(schema.cardioLog).all(),
    supplements: db.select().from(schema.supplement).all(),
    cheatSetting: db.select().from(schema.cheatSetting).all(),
    cheatLogs: db.select().from(schema.cheatLog).all(),
    checkins: db.select().from(schema.checkin).all(),
    reminderEvents: db.select().from(schema.reminderEvent).all(),
    reminderDeliveries: db.select().from(schema.reminderDelivery).all(),
    anchorProposals: db.select().from(schema.anchorProposal).all(),
    settings: db.select().from(schema.appSetting).all(),
  };
}
