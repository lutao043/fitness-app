/**
 * 会话 JWT（NFR-4 / D2）：jose 签发 HS256，30 天有效。
 *
 * 这里只放"签 / 验"这个纯函数对：能同时在 Node 运行时（路由处理器）与 Edge 运行时（middleware）里用，
 * 因为不碰数据库，也不碰 Node 的 crypto 私有 API。
 */

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "fitness_session";
export const SESSION_DAYS = 30;

export interface SessionPayload {
  /** 用户名（单用户，够用；不做多用户权限体系，第 12 章第 8 条） */
  sub: string;
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + SESSION_DAYS * 24 * 3600;
  return new SignJWT({ sub: payload.sub })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

export async function verifySession(
  token: string | undefined | null,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  };
}
