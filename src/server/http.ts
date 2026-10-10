/**
 * 接口层的公共设施：JSON 响应、请求体校验、错误形状（全中文提示，NFR-3）。
 *
 * 4xx 校验拒绝 / 5xx 异常都会打一行可观测性日志（issue #1 第 7 项）：调用方手里有
 * `request` 的就把 request 传进来（写接口都传），日志里才能带上路径 / ip / ua。
 */

import { logEvent, requestContext } from "@/server/logger";
import { logWrite, type ChangeFields } from "@/server/changelog";

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/**
 * 写操作的返回口（issue #40 / v1.41）：与 `json` 同形，只是**顺手记一行数据修改日志**
 * （`data/logs/changes-YYYY-MM-DD.log`，7 天保留与 `app-*.log` 同一套）。
 *
 * 改动摘要**不由路由各写一份**：白名单在 `server/changelog.ts` 里按路由模板配，
 * 值取写入口返回的派生值。路由要补日志时只在 `hint` 里给"写入口才知道的东西"
 * （比如删除类接口的 **before 值**）。写日志失败不影响业务。
 */
export function writeJson(
  request: Request,
  data: unknown,
  init?: ResponseInit,
  hint?: ChangeFields,
): Response {
  logWrite(request, init?.status ?? 200, data, hint);
  return Response.json(data, init);
}

export interface ApiErrorDetail {
  error: string;
  issues?: string[];
}

export function badRequest(error: string, issues?: string[], request?: Request): Response {
  logEvent({
    event: "api.reject",
    status: 400,
    detail: issues?.length ? `${error}（${issues.join("；")}）` : error,
    ...(request ? requestContext(request) : {}),
  });
  return Response.json({ error, issues } satisfies ApiErrorDetail, { status: 400 });
}

export function notFound(error: string): Response {
  return Response.json({ error } satisfies ApiErrorDetail, { status: 404 });
}

export function serverError(error: string, request?: Request): Response {
  logEvent({
    event: "api.server_error",
    status: 500,
    detail: error,
    ...(request ? requestContext(request) : {}),
  });
  return Response.json({ error } satisfies ApiErrorDetail, { status: 500 });
}

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, response: badRequest("请求体必须是 JSON 对象", undefined, request) };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: badRequest("请求体不是合法 JSON", undefined, request) };
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
