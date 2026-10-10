/**
 * 数据模型（需求书第 6 章 v1.13：全表、字段一步到位）。
 *
 * 几个容易踩的点（需求书第 6 章"要点"）：
 * - `holiday` 必须区分 `holiday`（放假）与 `workday`（周末补班）：**补班日算上班日**；
 * - 排期不存"未来某天该练什么"，一律实时推算 → 这里没有"日程表"，只有锚点 + 假期 + 顺延；
 * - `schedule_anchor` 只追加不修改（每方案各一条链），方便回溯"为什么今天显示这个部位"；
 * - 补剂打卡与 workout 打卡共用 `checkin` 一张表（**没有** supplement_log）；
 * - `checkin` 的 `(date, kind, ref_id)` 唯一：ref_id 用空串表示"不适用"（SQLite 里 NULL 不参与唯一性）；
 * - `workout_session.client_id` 是 POST /sessions 的幂等键（离线队列重试安全）。
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ExerciseType, LoadMode, LoadSemantics } from "@/lib/exercise/types";
import type { WeightUnit } from "@/lib/units";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** 通用 KV：种子只注入一次的标记、假期表写入元信息等 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** 设置项（单位 / 提醒时间 / 组间歇默认值…）：单用户，用 KV 就够，不加一列一张表 */
export const appSetting = sqliteTable("app_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const user = sqliteTable("user", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nickname: text("nickname").notNull().default("我"),
  heightCm: real("height_cm"),
  targetWeightKg: real("target_weight_kg"),
  /** argon2 哈希；为空表示还没设密码（首次启动走「设置密码」页，D2） */
  passwordHash: text("password_hash"),
  /** 助手调 /api/v1/* 用的 Bearer token 的哈希（设置页可重置） */
  apiTokenHash: text("api_token_hash"),
  createdAt: text("created_at").notNull().default(now),
});

/** 分化方案：循环长度 = 槽位数（3.1 / 4.2） */
export const splitScheme = sqliteTable("split_scheme", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  note: text("note").notNull().default(""),
  orderNo: integer("order_no").notNull().default(0),
  /** active 全局只有一套 */
  active: integer("active", { mode: "boolean" }).notNull().default(false),
});

/** 循环模板（槽位）：position 0..N-1，name 在同一方案内唯一 */
export const cycleTemplate = sqliteTable(
  "cycle_template",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schemeId: text("scheme_id")
      .notNull()
      .references(() => splitScheme.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    isRest: integer("is_rest", { mode: "boolean" }).notNull().default(false),
    /** 细分肌群（15 项，13.15） */
    muscles: text("muscles", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("cycle_template_scheme_position").on(t.schemeId, t.position),
    uniqueIndex("cycle_template_scheme_name").on(t.schemeId, t.name),
  ],
);

export const exercise = sqliteTable(
  "exercise",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** 细分肌群 JSON 数组；muscles[0] 是主肌群 */
    muscles: text("muscles", { mode: "json" }).$type<string[]>().notNull(),
    type: text("type").$type<ExerciseType>().notNull(),
    /** 器械 = 默认变体的器械（13.14：器械是变体属性，不是名字的一部分） */
    equip: text("equip").notNull(),
    loadMode: text("load_mode").$type<LoadMode>().notNull(),
    /** 杠重（仅 barbell；默认 20，动作级可改，如 EZ 杆 10） */
    barKg: real("bar_kg"),
    defaultSets: integer("default_sets").notNull().default(4),
    defaultReps: integer("default_reps").notNull().default(12),
    /** 参考起始重量（单侧口径） */
    baseWeight: real("base_weight"),
    /** 动作级默认组间歇（秒，10~600）；空 = 用全局默认 rest_default_sec（FR-52） */
    restSec: integer("rest_sec"),
    homeOk: integer("home_ok", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    orderNo: integer("order_no").notNull().default(0),
  },
  (t) => [uniqueIndex("exercise_name").on(t.name)],
);

/** 额外的器械变体（13.14）；默认变体 = 动作本身（键为裸动作名，不落这张表） */
export const exerciseVariant = sqliteTable(
  "exercise_variant",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercise.id, { onDelete: "cascade" }),
    /** 原型里的变体 id（如 v-cable），动作内唯一 */
    code: text("code").notNull(),
    equip: text("equip").notNull(),
    loadSemantics: text("load_semantics").$type<LoadSemantics>().notNull(),
    label: text("label").notNull().default(""),
    orderNo: integer("order_no").notNull().default(0),
    /** 变体级参考起始重量（可空，缺省回退动作级 baseWeight） */
    baseWeight: real("base_weight"),
    /**
     * 这台器械的**读数单位**（v1.38 / issue #36）：`"kg" | "lb"`，**可空 = 跟随全局设置**。
     * 美制器械按磅标读数，他照铭牌填就不会算错；**库内一律 kg**（录入时换算回去，13.1 口径不变）。
     * 老数据全 NULL = 行为与改造前完全一致，不需要洗数据。
     */
    readUnit: text("read_unit").$type<WeightUnit>(),
  },
  (t) => [uniqueIndex("exercise_variant_exercise_code").on(t.exerciseId, t.code)],
);

/** 槽位的动作清单：**每个槽位两套独立清单**（健身房 / 居家自重，13.x） */
export const cycleExercise = sqliteTable(
  "cycle_exercise",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    templateId: integer("template_id")
      .notNull()
      .references(() => cycleTemplate.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"gym" | "home">().notNull(),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercise.id),
    orderNo: integer("order_no").notNull(),
    targetSets: integer("target_sets").notNull(),
    targetReps: integer("target_reps").notNull(),
  },
  (t) => [index("cycle_exercise_template_mode").on(t.templateId, t.mode)],
);

/** 锚点链：只追加；生效锚点 = 该方案最新一条（每方案各一条链，切换方案互不干扰） */
export const scheduleAnchor = sqliteTable(
  "schedule_anchor",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schemeId: text("scheme_id")
      .notNull()
      .references(() => splitScheme.id, { onDelete: "cascade" }),
    anchorDate: text("anchor_date").notNull(),
    cyclePosition: integer("cycle_position").notNull(),
    reason: text("reason").notNull().default("initial"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("schedule_anchor_scheme").on(t.schemeId, t.id)],
);

/** 顺延：一天一条（重复调用 = no-op）；顺延日不占循环位 */
export const skipDay = sqliteTable(
  "skip_day",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    reason: text("reason").$type<"missed" | "overtime" | "holiday" | "manual">().notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("skip_day_date").on(t.date)],
);

/**
 * 循环位点（13.17）：**只影响该日及以后** —— 从 date 起循环位为 position，之后按占位日逐日推进；
 * 之前的日子仍按锚点 / 更早的位点算。加练的顺延靠它落地（不用追加锚点：锚点会把过去也改写）。
 */
export const cyclePoint = sqliteTable(
  "cycle_point",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schemeId: text("scheme_id")
      .notNull()
      .references(() => splitScheme.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    position: integer("position").notNull(),
    reason: text("reason").$type<"extra">().notNull().default("extra"),
    /** 绑那场加练会话：会话没开成 / 被删 / 置 aborted → 位点一起撤（13.17） */
    refSessionId: integer("ref_session_id").references(() => workoutSession.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("cycle_point_scheme_date").on(t.schemeId, t.date, t.id),
    index("cycle_point_session").on(t.refSessionId),
  ],
);

/** 法定节假日 / 补班日。唯一写入方是助手（PUT /api/v1/holidays，FR-24 / 13.12） */
export const holiday = sqliteTable("holiday", {
  date: text("date").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<"holiday" | "workday">().notNull(),
  updatedAt: text("updated_at").notNull().default(now),
  source: text("source").notNull().default("assistant"),
});

export const overtime = sqliteTable(
  "overtime",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    startTime: text("start_time").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("overtime_date").on(t.date)],
);

/** 训练会话。date = started_at 所在自然日（13.3，跨零点归属开始那天） */
export const workoutSession = sqliteTable(
  "workout_session",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 客户端生成的 UUID = POST /sessions 的幂等键 */
    clientId: text("client_id").notNull(),
    date: text("date").notNull(),
    templateId: integer("template_id").references(() => cycleTemplate.id),
    part: text("part").notNull(),
    mode: text("mode").$type<"gym" | "home">().notNull(),
    status: text("status").$type<"planned" | "doing" | "done" | "aborted">().notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    pausedSec: integer("paused_sec").notNull().default(0),
    restTargetSec: integer("rest_target_sec").notNull().default(90),
    /** 本次实际计划快照（可调过，只影响本次会话） */
    planSnapshot: text("plan_snapshot", { mode: "json" }).$type<unknown>(),
    summary: text("summary", { mode: "json" }).$type<unknown>(),
    /** 加练（13.17）：非训练日真练了 —— 开练时写循环位点，会话被删 / 置 aborted 时位点一起撤 */
    isExtra: integer("is_extra", { mode: "boolean" }).notNull().default(false),
    feel: text("feel"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("workout_session_client_id").on(t.clientId),
    index("workout_session_date").on(t.date),
    index("workout_session_status").on(t.status),
  ],
);

export const sessionExercise = sqliteTable(
  "session_exercise",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => workoutSession.id, { onDelete: "cascade" }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercise.id),
    orderNo: integer("order_no").notNull(),
    targetSets: integer("target_sets").notNull(),
    targetReps: integer("target_reps").notNull(),
    status: text("status").$type<"pending" | "done" | "skipped">().notNull().default("pending"),
  },
  (t) => [index("session_exercise_session").on(t.sessionId, t.orderNo)],
);

/** 组记录：每一组各记自己的变体；容量口径见 13.1 / 13.14 */
export const setLog = sqliteTable(
  "set_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * 客户端生成的幂等键（离线队列会原样重放请求，第 7 章"所有写接口可安全重试"）。
     * 同一 key 重复提交 = 覆盖同一组，不会记出两条。
     */
    clientKey: text("client_key"),
    sessionId: integer("session_id")
      .notNull()
      .references(() => workoutSession.id, { onDelete: "cascade" }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercise.id),
    setNo: integer("set_no").notNull(),
    /** 单侧读数（kg），原样保留 */
    weightKg: real("weight_kg"),
    reps: integer("reps"),
    durationSec: integer("duration_sec"),
    /** 可空 = 默认变体 */
    variantId: integer("variant_id").references(() => exerciseVariant.id, { onDelete: "set null" }),
    /** 按 loadMode / loadSemantics 折算的总重；不计容量时为 null */
    totalLoadKg: real("total_load_kg"),
    /** 自动记录的组间歇（上一组完成 → 本组开始），第一组为 null */
    restBeforeSec: integer("rest_before_sec"),
    /** 上一组是不是同动作 + 同变体（13.5） */
    sameExercise: integer("same_exercise", { mode: "boolean" }).notNull().default(false),
    doneAt: text("done_at").notNull(),
    feel: text("feel").$type<"easy" | "normal" | "hard" | "failure">(),
    skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),
    /**
     * 历史列（v1.18–v1.25 的「热身组」，FR-53 / 13.16）：**v1.26 起不再写入**（热身改成练前提示，
     * 不再记录组数）。老数据里 `is_warmup = 1` 的行仍按原口径处理：不计容量、不占目标组数、
     * 不参与预填 / PR / 趋势 / 组间歇均值（与 `skipped` 同一条"聚合时排除"路径）。
     * 列与读侧过滤都保留 —— 删列会让老热身组突然算进历史容量。
     */
    isWarmup: integer("is_warmup", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("set_log_client_key").on(t.clientKey),
    index("set_log_session").on(t.sessionId, t.id),
    index("set_log_exercise").on(t.exerciseId),
    index("set_log_done_at").on(t.doneAt),
  ],
);

/** 体重等身体数据：`(date, slot)` 唯一，同日同时点重复保存 = 覆盖（13.2） */
export const bodyMetric = sqliteTable(
  "body_metric",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    slot: text("slot").$type<"morning" | "bedtime" | "other">().notNull().default("morning"),
    weightKg: real("weight_kg").notNull(),
    bodyFatPct: real("body_fat_pct"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("body_metric_date_slot").on(t.date, t.slot)],
);

/**
 * 每日体重分析（FR-57，v1.29）：**助手生成 → App 只展示**。
 * `date` 主键 = 同一天重复写入 = 覆盖（幂等，与 `body_metric` 的 `(date, slot)` 同思路）；
 * App 不生成文案、也没有写入入口（网页只读展示，与假期表 / 助手 token 一致）。
 */
export const bodyAnalysis = sqliteTable("body_analysis", {
  date: text("date").primaryKey(),
  /** normal（正常波动）/ watch（值得留意）/ suspect（数据可疑）—— 展示层的徽标色按它分 */
  level: text("level").$type<"normal" | "watch" | "suspect">().notNull(),
  text: text("text").notNull(),
  /** 写入方：固定 assistant（服务端写死，不收调用方的值） */
  source: text("source").notNull().default("assistant"),
  createdAt: text("created_at").notNull().default(now),
  /** 同一天重写会刷新它（`created_at` 保留第一次写入的时间） */
  updatedAt: text("updated_at").notNull().default(now),
});

/** 围度（FR-15，P1；MVP 只用表，不做界面） */
export const measurement = sqliteTable(
  "measurement",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    waistCm: real("waist_cm"),
    chestCm: real("chest_cm"),
    armCm: real("arm_cm"),
    thighCm: real("thigh_cm"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("measurement_date").on(t.date)],
);

/**
 * 有氧（爬坡走，FR-50 / v1.16）：**只记分钟数**，坡度与速度不记（3.6 不做精算）；一天一条、重复保存 = 覆盖。
 * 口径：第三类事实 —— 不算出勤、不进容量、不参与 streak（13.4 / 13.6）。
 */
export const cardioLog = sqliteTable(
  "cardio_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("cardio_log_date").on(t.date)],
);

/** 补剂清单：完全可增删改（名称 / 时点 / 剂量 / 排序 / 启用） */
export const supplement = sqliteTable("supplement", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** 提醒时点列表（JSON 数组，HH:mm） */
  times: text("times", { mode: "json" }).$type<string[]>().notNull().default([]),
  doseText: text("dose_text").notNull().default(""),
  orderNo: integer("order_no").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const cheatSetting = sqliteTable("cheat_setting", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  intervalDays: integer("interval_days").notNull().default(8),
  anchorDate: text("anchor_date").notNull(),
});

export const cheatLog = sqliteTable("cheat_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull().default(now),
});

/**
 * 打卡 = 出勤事实（**不等于**训练明细，13.4）。
 * 补剂打卡的唯一事实源就是这张表（ref_id = 补剂 id；没有第二张补剂打卡表）。
 */
export const checkin = sqliteTable(
  "checkin",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    kind: text("kind").$type<"workout" | "supplement">().notNull(),
    /** 补剂打卡为补剂 id；workout 打卡用空串（SQLite 里 NULL 不参与唯一约束） */
    refId: text("ref_id").notNull().default(""),
    source: text("source").$type<"web" | "assistant" | "reminder">().notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("checkin_date_kind_ref").on(t.date, t.kind, t.refId),
    index("checkin_date").on(t.date),
  ],
);

/** 提醒事件：去重键 = (type, ref_key, date)，全天只生成一条 */
export const reminderEvent = sqliteTable(
  "reminder_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type")
      .$type<"workout" | "supplement" | "cheat" | "reanchor" | "holiday_gap">()
      .notNull(),
    refKey: text("ref_key").notNull(),
    date: text("date").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("reminder_event_type_ref_date").on(t.type, t.refKey, t.date)],
);

/** 投递：按渠道各记一次；同一 (event_id, channel) 只记一条（FR-36 / FR-37） */
export const reminderDelivery = sqliteTable(
  "reminder_delivery",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => reminderEvent.id, { onDelete: "cascade" }),
    channel: text("channel").$type<"feishu" | "pwa">().notNull(),
    sentAt: text("sent_at").notNull().default(now),
    status: text("status").$type<"sent" | "dry_run">().notNull().default("sent"),
  },
  (t) => [uniqueIndex("reminder_delivery_event_channel").on(t.eventId, t.channel)],
);

/** 重锚建议（FR-38：先问再改，禁止自动重锚） */
export const anchorProposal = sqliteTable("anchor_proposal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  suggestedPosition: integer("suggested_position").notNull(),
  status: text("status").$type<"pending" | "accepted" | "rejected">().notNull().default("pending"),
  decidedAt: text("decided_at"),
  createdAt: text("created_at").notNull().default(now),
});
