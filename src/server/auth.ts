/**
 * 认证的服务端收口（D2 / NFR-4 / 需求书第 7 章）。
 *
 * 两条认证路径：
 * - 网页：session cookie（jose 签的 JWT，30 天）；
 * - 机器（助手）：`Authorization: Bearer <token>`，token 的 argon2 哈希入库，设置页可重置。
 *
 * 全部时间与身份校验都在这里，路由只调 `requireApiAuth()` / `getSessionUser()`。
 */

import type { Db } from "@/db/client";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "@/lib/auth/session";
import { logEvent, requestContext } from "@/server/logger";

const globalForSecret = globalThis as unknown as { __fitnessSessionSecret?: string };

/**
 * SESSION_SECRET 缺失时（本机开发）生成一个进程内随机密钥：
 * 服务重启会让已登录的会话失效 —— 生产/Docker 必须配 .env（.env.example 有说明）。
 */
export function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (!globalForSecret.__fitnessSessionSecret) {
    globalForSecret.__fitnessSessionSecret = crypto.randomUUID() + crypto.randomUUID();
    console.warn("[auth] 没有配置 SESSION_SECRET，已生成临时密钥（重启后需要重新登录）");
  }
  return globalForSecret.__fitnessSessionSecret;
}

export function appUsername(): string {
  return process.env.APP_USERNAME ?? "me";
}

export function userRow(db: Db = getDb()) {
  return db.select().from(schema.user).orderBy(schema.user.id).get() ?? null;
}

export function hasPassword(db: Db = getDb()): boolean {
  return !!userRow(db)?.passwordHash;
}

export async function verifyLogin(password: string, db: Db = getDb()): Promise<boolean> {
  const user = userRow(db);
  if (!user?.passwordHash) return false;
  return verifyPassword(user.passwordHash, password);
}

export async function getSessionUser(): Promise<SessionPayload | null> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    return verifySession(token, sessionSecret());
  } catch {
    // 没有请求上下文（脚本 / 接口级测试）时按"没有会话"处理，由调用方决定 401 还是跳登录页
    return null;
  }
}

export interface AuthResult {
  ok: boolean;
  via: "session" | "token" | null;
  /** 未认证时的响应 */
  response?: Response;
}

function unauthorized(message: string, request?: Request): Response {
  // 登录失败（401）打一行可观测性日志（issue #1 第 7 项）：只记路径/ip/ua，不碰请求体与 token
  logEvent({ event: "api.unauthorized", status: 401, detail: message, ...(request ? requestContext(request) : {}) });
  return Response.json({ error: message }, { status: 401 });
}

/** 路由处理器统一入口：session 或 Bearer token，二者其一即可 */
export async function requireApiAuth(request: Request, db: Db = getDb()): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const expected = process.env.API_TOKEN;
    if (expected && token && token === expected) return { ok: true, via: "token" };
    const user = userRow(db);
    if (user?.apiTokenHash && (await verifyPassword(user.apiTokenHash, token))) {
      return { ok: true, via: "token" };
    }
    return { ok: false, via: null, response: unauthorized("Bearer token 不正确", request) };
  }
  const session = await getSessionUser();
  if (session) return { ok: true, via: "session" };
  return { ok: false, via: null, response: unauthorized("未登录（请先登录或带 Bearer token）", request) };
}
