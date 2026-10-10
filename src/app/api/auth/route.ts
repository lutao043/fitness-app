/**
 * 登录 / 首次设置密码 / 退出（D2 / NFR-4）。
 *
 * - 首次启动没有密码 → 走「设置密码」；已有密码时改密码要先验旧密码；
 * - 会话 = jose 签的 JWT，存 httpOnly cookie，30 天；
 * - 单用户，不做注册 / 找回（第 12 章第 8 条：别过度设计权限体系）。
 */

import { getDb } from "@/db/client";
import { setUserPassword } from "@/db/writes";
import { hashPassword, passwordIssue } from "@/lib/auth/password";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { appUsername, hasPassword, sessionSecret, userRow, verifyLogin } from "@/server/auth";
import { badRequest, json, readJsonBody } from "@/server/http";
import { logEvent, requestContext } from "@/server/logger";
import {
  LOCK_MS,
  MAX_FAILS,
  loginThrottleCheck,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/server/login-throttle";

export const dynamic = "force-dynamic";

/**
 * Secure 标记只按本次请求的实际协议决定：浏览器对纯 HTTP 响应里的 Secure cookie
 * 直接丢弃（localhost 除外），内网 HTTP 直访的生产模式下若按 NODE_ENV 加 Secure，
 * 登录/设密码虽成功但会话存不下来，跳首页会被 middleware 又踢回登录页。
 * 反代场景以 x-forwarded-proto 为准，直连场景看请求 URL 协议。
 */
function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function cookieHeader(token: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function loggedInResponse(secure: boolean): Promise<Response> {
  const token = await signSession({ sub: appUsername() }, sessionSecret());
  return json(
    { ok: true, username: appUsername() },
    { status: 200, headers: { "set-cookie": cookieHeader(token, 30 * 24 * 3600, secure) } },
  );
}

/** GET —— 当前登录状态与「有没有设过密码」（登录页据此决定展示哪个表单） */
export async function GET() {
  const { getSessionUser } = await import("@/server/auth");
  const session = await getSessionUser();
  const user = userRow(getDb());
  return json({
    hasPassword: !!user?.passwordHash,
    loggedIn: !!session,
    username: appUsername(),
    hasApiToken: !!process.env.API_TOKEN || !!user?.apiTokenHash,
  });
}

/** POST ?action=setup|login|logout */
export async function POST(request: Request) {
  const action = new URL(request.url).searchParams.get("action") ?? "";

  const secure = isHttps(request);

  if (action === "logout") {
    // 登出不需要 body，先于 readJsonBody 返回 —— 否则空 body 会在读体时 400、永远登不出
    return json({ ok: true }, { headers: { "set-cookie": cookieHeader("", 0, secure) } });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const db = getDb();

  if (action === "setup") {
    const password = typeof body.password === "string" ? body.password : "";
    const issue = passwordIssue(password);
    if (issue) return badRequest(issue, undefined, request);
    if (hasPassword(db)) {
      // 已经有密码：改密码先验旧的（防误改/误操作）
      const current = typeof body.current === "string" ? body.current : "";
      if (!(await verifyLogin(current, db))) return badRequest("当前密码不正确", undefined, request);
    }
    setUserPassword(db, await hashPassword(password));
    return loggedInResponse(secure);
  }

  if (action === "login") {
    const password = typeof body.password === "string" ? body.password : "";
    // 失败节流（issue #32）：锁定期内直接拒，连正确密码也不放行（避免"边试边等"）
    const gate = loginThrottleCheck(Date.now());
    if (gate.blocked) {
      logEvent({
        event: "login_locked",
        status: 429,
        detail: `登录已锁定，约 ${gate.retryAfterSec} 秒后重试`,
        ...requestContext(request),
      });
      return json(
        { error: `密码错误次数过多，请约 ${Math.ceil((gate.retryAfterSec ?? 0) / 60)} 分钟后再试` },
        { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 0) } },
      );
    }
    if (!(await verifyLogin(password, db))) {
      // 密码本身绝不落日志（issue #1 第 7 项：只记事实，不记凭据）
      const after = recordLoginFailure(Date.now());
      logEvent({ event: "login_failed", status: 401, ...requestContext(request) });
      if (after.blocked) {
        // 锁定事实单独记一笔（"为什么现在登不进来"在日志里查得到）
        logEvent({
          event: "login_locked",
          status: 401,
          detail: `连续失败 ${MAX_FAILS} 次，锁定 ${Math.round(LOCK_MS / 60000)} 分钟`,
          ...requestContext(request),
        });
      }
      return json({ error: "密码不正确" }, { status: 401 });
    }
    recordLoginSuccess();
    return loggedInResponse(secure);
  }

  return badRequest("action 只能是 setup / login / logout", undefined, request);
}
