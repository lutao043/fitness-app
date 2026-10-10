"use client";

/**
 * 客户端 API 封装（浏览器侧唯一的出网口）。
 *
 * 统一把错误转成中文提示（NFR-3），并把 401 统一处理成"跳到登录页"。
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
    throw new ApiError("未登录", 401);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; issues?: string[] };
    throw new ApiError(body.error ?? `请求失败（${res.status}）`, res.status, body.issues);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) }),
};

/* ————————————— 数据类型（与 server 侧保持一致；只声明 UI 用得到的字段） ————————————— */

export interface TodayExercise {
  exerciseId: number;
  name: string;
  type: "weight" | "reps" | "time";
  muscles: string[];
  groups: string[];
  equip: string;
  loadMode: string;
  barKg: number | null;
  baseWeight: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52） */
  restSec: number | null;
  note: string | null;
  targetSets: number;
  targetReps: number;
  variants: {
    id: number | null;
    code: string | null;
    equip: string;
    semantics: string;
    label: string;
    /** 这台器械的读数单位（v1.38）；null = 跟随全局设置 */
    readUnit?: "kg" | "lb" | null;
  }[];
  lastByVariant: Record<
    string,
    { weightKg: number | null; reps: number | null; durationSec: number | null; doneAt: string } | null
  >;
}

export interface TodayPayload {
  date: string;
  weekday: string;
  formatted: string;
  time: string;
  holiday: { name: string; type: "holiday" | "workday" } | null;
  scheme: { id: string; name: string; cycleLen: number; slotIndex: number; templateId: number | null };
  part: string;
  /** true = 今天临时改练了别的部位（FR-4），排期与锚点都没动 */
  partOverride: boolean;
  /** 展示单位（§1.1）：库里一律 kg，页面按它换算重量与体重 */
  unit: "kg" | "lb";
  mode: "gym" | "home";
  isRestDay: boolean;
  isTrainingDay: boolean;
  skipped: boolean;
  exercises: TodayExercise[];
  session: {
    id: number;
    clientId: string;
    status: string;
    part: string;
    mode: string;
    startedAt: string | null;
    endedAt: string | null;
    summary: { totalSets?: number; volumeKg?: number; durationSec?: number | null; minutes?: number } | null;
    /** 完成度（issue #45）：主标 `已记组数 / 目标之和`、副标 `做满动作数 / 参与动作数` */
    completion?: { setsText: string; exercisesText: string; totalSets: number };
    /** 加练（13.17）：非训练日真练了的那一场 */
    isExtra?: boolean;
  } | null;
  checkin: { workout: boolean };
  /** 目标体重（距目标统一读它，别硬编码 65） */
  target: number | null;
  /** 今日补剂清单（打卡段） */
  supplements: { id: number; name: string; doseText: string; times: string[]; takenToday: boolean }[];
  overtime: { id: number; start: string; note: string | null; verdict: "ok" | "late" }[];
  overtimeEarliest: { start: string; verdict: "ok" | "late" } | null;
  /** 加练（13.17）已生效时的提示：休息顺延到哪天 + 接下来练什么 */
  extraShift?: { restDate: string | null; nextTraining: { date: string; part: string } | null } | null;
  /** 今天 / 明天的日子类型（13.11）：加班卡按它决定要不要判定"耽误训练" */
  dayTypes?: Record<string, DayKind>;
  /** daysSince 为 null = 从没记过放纵餐（显示「还没有记录」） */
  cheat: { daysSince: number | null; nextDate: string; when: string; intervalDays: number };
  recovery: {
    group: string;
    key: "none" | "recovering" | "mostly" | "recovered";
    label: string;
    hoursSince: number | null;
    pct: number;
    nextDays: number | null;
  }[];
  /** FR-20：最近 7 天各大部位练了几天 */
  partFrequency: { group: string; days: number }[];
  /** 有氧（FR-50 / v1.16）：今天记了没 + 近 7 天合计（不算出勤/容量/streak） */
  cardio: { today: { minutes: number; note: string | null } | null; weekMinutes: number; weekDays: number };
  streak: number;
  debt: { owed: { date: string; part: string }[]; text: string | null; needsReanchorBeforeSkip: boolean };
  reanchor: { trainingDaysMissed: number; shouldAsk: boolean };
  reminders: { enabled: boolean; time: string; statusText: string };
  holidayGap: { enough: boolean; coverageEnd: string | null; text: string | null; due: boolean };
  receipt: { date: string; time: string; hoursSince: number } | null;
  body: {
    latestMorning: { date: string; weightKg: number; slot: string } | null;
    latestAny: { date: string; weightKg: number; slot: string } | null;
    isToday: boolean;
  };
}

export interface SessionDetail {
  session: {
    id: number;
    clientId: string;
    date: string;
    part: string;
    mode: "gym" | "home";
    status: "planned" | "doing" | "done" | "aborted";
    startedAt: string | null;
    endedAt: string | null;
    restTargetSec: number;
    summary: {
      totalSets?: number;
      volumeKg?: number;
      /** 训练时长（秒，墙上时间）；null / 缺省 = 拿不到，显示「—」（13.3 v1.34） */
      durationSec?: number | null;
      minutes?: number;
      avgRestSec?: number;
      avgChangeoverSec?: number;
    } | null;
  };
  exercises: {
    id: number;
    exerciseId: number;
    name: string;
    type: "weight" | "reps" | "time";
    equip: string;
    muscles: string[];
    loadMode: string;
    barKg: number | null;
    baseWeight: number | null;
    /** 动作级默认组间歇（秒）；空 = 全局默认（FR-52） */
    restSec: number | null;
    orderNo: number;
    targetSets: number;
    targetReps: number;
    status: string;
    /** 器械变体（13.14）：默认变体 id = null（就是动作本身） */
    variants: {
      id: number | null;
      code: string | null;
      equip: string;
      semantics: 'direct' | 'ratio_2to1' | 'assist' | 'band';
      label: string;
      baseWeight: number | null;
      /** 这台器械的读数单位（v1.38）；null = 跟随全局设置（`effectiveReadUnit` 算生效值） */
      readUnit: "kg" | "lb" | null;
    }[];
  }[];
  sets: {
    id: number;
    exerciseId: number;
    exerciseName: string;
    exerciseType: "weight" | "reps" | "time";
    variantId: number | null;
    variantCode: string | null;
    variantLabel: string | null;
    setNo: number;
    weightKg: number | null;
    reps: number | null;
    durationSec: number | null;
    totalLoadKg: number | null;
    restBeforeSec: number | null;
    sameExercise: boolean;
    doneAt: string;
    feel: string | null;
    /** 老数据里的热身行（FR-53 / 13.16；v1.26 起不再记录）：不计容量 / 组数 / 预填 / 趋势 */
    isWarmup: boolean;
  }[];
  /** 完成度（issue #45）：主标 `已记组数 / 目标之和`、副标 `做满动作数 / 参与动作数` */
  completion: { setsText: string; exercisesText: string; totalSets: number };
  summary: {
    totalSets: number;
    volumeKg: number;
    /** 训练时长（秒，墙上时间 = ended_at − started_at，含暂停）；null = 拿不到，显示「—」 */
    durationSec: number | null;
    /** durationSec 的分钟取整；**先判 durationSec 再决定显不显示这个数** */
    minutes: number;
    avgRestSec: number;
    avgChangeoverSec: number;
  };
  /** 展示单位（§1.1）：组值 / 预填 / 容量都按它换算，库里始终 kg */
  unit: "kg" | "lb";
}

export interface HistoryRow {
  kind: "session" | "checkin" | "cardio";
  date: string;
  id: number;
  part: string;
  mode: string;
  status: string;
  sets: number;
  summary: { totalSets?: number; volumeKg?: number } | null;
  partOfDay: string | null;
  /** 有氧行：分钟数（FR-51） */
  cardioMinutes: number | null;
  /** 加练（13.17）：非训练日真练了的那一场（记录页带「加练」标记） */
  isExtra?: boolean;
}

export interface BodySeries {
  series: { id: number; date: string; slot: string; weightKg: number; bodyFatPct: number | null }[];
  latestMorning: { date: string; weightKg: number } | null;
  latestAny: { date: string; weightKg: number; slot: string } | null;
  target: number;
  /** 展示单位（§1.1）：体重按它换算展示与录入，库里始终 kg */
  unit: "kg" | "lb";
}

/** 每日体重分析（FR-57 / v1.29）：助手写入、网页只读展示（身体页「趋势解读」） */
export interface BodyAnalysisRow {
  date: string;
  level: "normal" | "watch" | "suspect";
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** 围度（FR-15 / 第 6 章 measurement 表：同日一条） */
export interface MeasurementRow {
  id: number;
  date: string;
  waistCm: number | null;
  chestCm: number | null;
  armCm: number | null;
  thighCm: number | null;
}

export interface SettingsPayload {
  unit: "kg" | "lb";
  reminderTime: string;
  workoutReminderOn: boolean;
  restDefaultSec: number;
  holidays: { updatedAt: string | null; source: string | null };
  scheme: {
    id: string;
    name: string;
    cycleLen: number;
    slotIndex: number;
    anchorDate: string;
    anchorPosition: number;
    anchorReason: string;
    /** 这一天这个场景对应的槽位模板 id（「把这套存回模板」用） */
    templateId: number | null;
    slots: { label: string; rest: boolean; muscles: string[] }[];
  };
  /** 放纵餐（FR-25）：间隔在设置页改，锚点靠首页「今天真吃了」挪 */
  cheat: { intervalDays: number; anchorDate: string | null; lastLogDate: string | null; logCount: number };
}

/* ————————————— 规则管理（v1.2：方案 / 槽位 / 动作库 / 补剂 / 重锚建议） ————————————— */

/** 槽位里的一条动作（目标来自槽位清单 template × mode） */
export interface SlotExerciseRow {
  exerciseId: number;
  name: string;
  type: "weight" | "reps" | "time";
  muscles: string[];
  groups: string[];
  equip: string;
  loadMode: string;
  baseWeight: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52） */
  restSec: number | null;
  targetSets: number;
  targetReps: number;
}

export interface SlotAdmin {
  templateId: number;
  position: number;
  label: string;
  rest: boolean;
  muscles: string[];
  gym: SlotExerciseRow[];
  home: SlotExerciseRow[];
}

export interface SchemeAdmin {
  id: string;
  name: string;
  note: string;
  orderNo: number;
  active: boolean;
  slots: SlotAdmin[];
  anchor: { date: string; position: number; reason: string } | null;
}

export interface ExerciseVariantView {
  id: number;
  code: string;
  equip: string;
  semantics: "direct" | "ratio_2to1" | "assist" | "band";
  label: string;
  baseWeight: number | null;
  /** 读数单位（v1.38）：null = 跟随全局设置 */
  readUnit: "kg" | "lb" | null;
}

/** 动作库全量（维护界面）：含变体与引用计数 */
export interface ExerciseLibraryRow {
  id: number;
  name: string;
  muscles: string[];
  groups: string[];
  type: "weight" | "reps" | "time";
  equip: string;
  loadMode: "barbell" | "dumbbell" | "machine" | "bodyweight" | "single_side";
  barKg: number | null;
  defaultSets: number;
  defaultReps: number;
  baseWeight: number | null;
  /** 动作级默认组间歇（秒）；空 = 用全局默认（FR-52） */
  restSec: number | null;
  homeOk: boolean;
  note: string | null;
  orderNo: number;
  variants: ExerciseVariantView[];
  templateRefs: number;
  setCount: number;
}

export interface SupplementRow {
  id: number;
  name: string;
  times: string[];
  doseText: string;
  orderNo: number;
  enabled: boolean;
}

export interface ReanchorProposal {
  id: number;
  date: string;
  suggested_position: number;
  status: string;
  created_at: string;
}


/** GET /api/v1/stats —— 记录页统计卡（出勤率口径 13.4） */
export interface HistoryStats {
  days: number;
  from: string;
  to: string;
  totalSets: number;
  volumeKg: number;
  plannedDays: number;
  attendedDays: number;
  /** 展示单位（§1.1）：容量按它换算展示 */
  unit: "kg" | "lb";
  /** FR-26：各部位组数与容量（13.15 大部位口径） */
  parts: { group: string; sets: number; volumeKg: number }[];
}

/** FR-27：动作 × 变体的重量趋势（每场当日最大单侧重量） */
export interface ExerciseTrendRow {
  date: string;
  maxWeightKg: number | null;
  sets: number;
  volumeKg: number;
}

/** FR-27 选择器：有记录的「动作 × 变体」 */
export interface RecordedVariantRow {
  exerciseId: number;
  exerciseName: string;
  variantId: number | null;
  variantLabel: string | null;
  sets: number;
  lastDate: string;
}

export interface OvertimeRow {
  id: number;
  date: string;
  startTime: string;
  note: string | null;
  /** 那天是训练日 / 休息日 / 假期（13.11 / v1.20）：休息日与假期只记录、不判定"耽误训练" */
  dayType?: DayKind;
}

/** 某天的日子类型（13.11）：加班只在训练日才判"耽误训练" */
export type DayKind = "training" | "rest" | "holiday";

/* ————————————— 常用查询 key ————————————— */

export const qk = {
  today: (mode: "gym" | "home" = "gym") => ["today", mode] as const,
  session: (id: number) => ["session", id] as const,
  history: () => ["history"] as const,
  body: () => ["body"] as const,
  /** 每日体重分析（FR-57 / v1.29；助手写入、网页只读） */
  bodyAnalysis: () => ["body-analysis"] as const,
  measurements: () => ["measurements"] as const,
  settings: () => ["settings"] as const,
  /** 助手接口 token 的状态（只回「有没有配」，不回 token 本身；需求书第 7 章） */
  apiToken: () => ["api-token"] as const,
  holidays: () => ["holidays"] as const,
  stats: () => ["stats"] as const,
  overtimes: () => ["overtimes"] as const,
  schemes: () => ["schemes"] as const,
  exercises: () => ["exercises"] as const,
  /** 内置动作库补齐的预览（v1.22：还缺哪些内置动作） */
  exerciseSync: () => ["exercise-sync"] as const,
  supplements: () => ["supplements"] as const,
  proposals: () => ["reanchor", "proposals"] as const,
  cardio: (days = 14) => ["cardio", days] as const,
};
