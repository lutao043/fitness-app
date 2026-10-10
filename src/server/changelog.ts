/**
 * 数据修改日志（issue #40 / v1.41）：**每条成功的写操作一行 JSON**，落 `data/logs/changes-YYYY-MM-DD.log`
 * （与 `app-*.log` 同一套按天轮转与 7 天保留，见 `logger.ts` 的 `pruneOldLogs`）。
 *
 * 红线（不许违背）：
 * 1. **不记请求体全文** —— 只记白名单字段（`CHANGE_WHITELIST`），值取**写入口返回的派生值**（响应体），
 *    不是用户原始输入（单位换算、单侧折算、时区都在中间层，原始输入未必等于最终落库值）；
 * 2. **绝不出现 token / cookie / 密码 / argon2 哈希**（只记"来源=token/session"这个结论）；
 * 3. **只记写操作**（POST / PUT / PATCH / DELETE），GET 一律不记；
 * 4. **写日志失败不得影响业务**：异常静默吞掉（同 logger 的容错口径）；
 * 5. 7 天保留与 `app-*.log` **共用同一份清理实现**，不再造第二套。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dateInTz } from "@/lib/time";
import { logsDir, requestContext } from "@/server/logger";

export interface ChangeFields {
  /**
   * 来源：`session` = 他自己在网页上改；`assistant` = 助手用 token 调的。
   * **刻意不写 `token` 这个字面**：验收要求 `grep -i token` 零命中（日志里出现这个词会让巡检误报），
   * 而 `via` 要表达的是"谁改的"这个结论，不是凭据本身。
   */
  via?: "session" | "assistant";
  method?: string;
  path?: string;
  /** 资源标识：`session_id` / `set_id` / `exercise_id` / `template_id` / `date` … */
  target?: Record<string, unknown>;
  /** 改动摘要：新增记 after 值、删除记 before 值、幂等重放记 `{ignored: true}` */
  change?: unknown;
  status?: number;
  ip?: string;
  ua?: string;
}

/** 改动日志的路径（与 app-*.log 同目录、同轮转） */
export function changesLogPath(date: string = dateInTz()): string {
  return join(logsDir(), `changes-${date}.log`);
}

/** 一行一条 JSON；stdout 先行、写失败静默（日志永远不能影响请求本身） */
export function logChange(fields: ChangeFields): void {
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  } catch {
    return; // 摘要里有循环引用之类：宁可不记，也不能让请求挂掉
  }
  try {
    console.log(line);
  } catch {
    // console 都不可用时只能放弃
  }
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(changesLogPath(), `${line}\n`);
  } catch {
    // 静默：磁盘满 / 权限问题不该把接口打挂
  }
}

/**
 * 路由模板（把数字段换成 `:id`）：`/api/v1/sessions/12/sets/3` → `/api/v1/sessions/:id/sets/:id`。
 * 白名单按这个模板配，所以加一台新路由不用改日志代码。
 */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^\d{4}-\d{2}-\d{2}$/.test(seg) ? ":id" : seg))
    .join("/");
}

/** 路径里的资源标识（给 `target` 用：`sessions/12/sets/3` → `{session_id: 12, set_id: 3}`） */
export function targetFromPath(pathname: string): Record<string, unknown> {
  const segs = pathname.split("/").filter(Boolean);
  const target: Record<string, unknown> = {};
  const map: Record<string, string> = {
    sessions: "session_id",
    sets: "set_id",
    exercises: "exercise_id",
    variants: "variant_id",
    schemes: "scheme_id",
    slots: "template_id",
    supplements: "supplement_id",
    reminders: "reminder_id",
    proposals: "proposal_id",
    skip: "date",
  };
  for (let i = 0; i < segs.length - 1; i++) {
    const key = map[segs[i]];
    const value = segs[i + 1];
    if (key && key !== "date" && /^\d+$/.test(value)) target[key] = Number(value);
    if (key === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) target.date = value;
  }
  return target;
}

/**
 * 改动摘要的白名单（**唯一的一份**）：值只从写入口返回的响应体里取。
 * 用 `*` 匹配一个路径段（`:id` 之类已经归一化，所以直接写 `:id`）。
 */
const CHANGE_WHITELIST: { pattern: string; fields: string[] }[] = [
  { pattern: "/api/v1/sessions", fields: ["id", "date", "status", "extra", "created"] },
  { pattern: "/api/v1/sessions/:id", fields: ["id", "status", "summary"] },
  { pattern: "/api/v1/sessions/:id/sets", fields: ["id", "created", "setNo", "weightKg", "reps", "totalLoadKg", "volumeKg"] },
  { pattern: "/api/v1/sessions/:id/sets/:id", fields: ["id", "removed", "updated"] },
  { pattern: "/api/v1/sessions/:id/exercises", fields: ["id", "orderNo", "removed", "deletedSets"] },
  { pattern: "/api/v1/sessions/:id/exercises/move", fields: ["changed", "fromExerciseId", "toExerciseId", "movedSets", "volumeBeforeKg", "volumeAfterKg"] },
  { pattern: "/api/v1/exercises", fields: ["id", "name"] },
  { pattern: "/api/v1/exercises/:id", fields: ["id", "updated", "removed"] },
  { pattern: "/api/v1/exercises/:id/variants", fields: ["id", "code", "equip", "semantics", "readUnit"] },
  { pattern: "/api/v1/exercises/:id/variants/:id", fields: ["id", "equip", "semantics", "readUnit", "removed"] },
  { pattern: "/api/v1/exercises/sync", fields: ["added", "created", "skipped"] },
  { pattern: "/api/v1/body-metrics", fields: ["id", "date", "slot", "created", "removed"] },
  { pattern: "/api/v1/measurements", fields: ["id", "date", "created"] },
  { pattern: "/api/v1/cardio", fields: ["id", "date", "minutes", "created", "removed"] },
  { pattern: "/api/v1/checkin", fields: ["id", "date", "kind", "created", "source"] },
  { pattern: "/api/v1/skip", fields: ["id", "date", "reason", "written"] },
  { pattern: "/api/v1/overtime", fields: ["id", "date", "start", "removed", "updated"] },
  { pattern: "/api/v1/skip/:id", fields: ["date", "removed"] },
  { pattern: "/api/v1/settings", fields: ["unit", "reminderTime", "cheatIntervalDays"] },
  { pattern: "/api/v1/settings/api-token", fields: ["hasToken"] },
  { pattern: "/api/v1/supplements", fields: ["id", "name", "enabled"] },
  { pattern: "/api/v1/supplements/:id", fields: ["id", "name", "enabled", "removed"] },
  { pattern: "/api/v1/schemes", fields: ["id", "name", "created"] },
  { pattern: "/api/v1/schemes/import", fields: ["id", "name", "created"] },
  { pattern: "/api/v1/schemes/:id", fields: ["id", "name", "removed"] },
  { pattern: "/api/v1/schemes/:id/slots", fields: ["id", "position", "label"] },
  { pattern: "/api/v1/schemes/:id/slots/:id", fields: ["id", "label", "removed"] },
  { pattern: "/api/v1/schemes/:id/slots/:id/exercises", fields: ["count", "saved"] },
  { pattern: "/api/v1/holidays", fields: ["year", "written", "replaced"] },
  { pattern: "/api/v1/cheat-meals", fields: ["id", "date", "nextDate", "created"] },
  { pattern: "/api/v1/reanchor", fields: ["id", "date", "cyclePosition"] },
  { pattern: "/api/v1/reanchor/proposals/:id", fields: ["id", "decision"] },
  { pattern: "/api/v1/reminders/:id/sent", fields: ["id", "channel", "status"] },
  { pattern: "/api/v1/body-analysis", fields: ["date", "level", "created"] },
  { pattern: "/api/v1/restore", fields: ["ok", "applied", "dryRun"] },
];

/**
 * 按路由模板挑白名单字段（**纯函数，可单测**）。
 * `created === false` = 幂等重放被忽略，补一个 `ignored: true` —— 方便回看"我明明点了一次"（issue #40 红线 6）。
 */
export function changeSummaryFor(pathname: string, body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const pattern = routePattern(pathname);
  const rule = CHANGE_WHITELIST.find((r) => r.pattern === pattern);
  if (!rule) return undefined;
  const source = body as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of rule.fields) {
    const value = source[field];
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") continue; // 嵌套对象一律不进日志（体积不可控）
    picked[field] = value;
  }
  if (Object.keys(picked).length === 0) return undefined;
  if (picked.created === false) picked.ignored = true;
  return picked;
}

/** 写操作成功时记一行（由 `writeJson` 调用；缺什么字段就不写什么字段） */
export function logWrite(request: Request, status: number, body: unknown, hint?: ChangeFields): void {
  try {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return; // 只记写操作
    const url = new URL(request.url);
    const ctx = requestContext(request);
    logChange({
      via:
        hint?.via ??
        (request.headers.get("authorization")?.toLowerCase().startsWith("bearer ") ? "assistant" : "session"),
      method,
      path: url.pathname,
      target: { ...targetFromPath(url.pathname), ...(hint?.target ?? {}) },
      change: hint?.change ?? changeSummaryFor(url.pathname, body),
      status,
      ip: ctx.ip,
      ua: ctx.ua,
    });
  } catch {
    // 日志永远不能影响写操作本身
  }
}
