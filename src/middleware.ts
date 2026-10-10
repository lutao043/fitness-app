/**
 * 页面与接口的入口守卫（NFR-4：单用户登录，会话保持 30 天）。
 *
 * 这里只做"cookie 里有没有一个验得过的 JWT"这一层（jose 在 Edge 运行时也能跑，不碰数据库）；
 * 真正的数据访问与 Bearer token 校验在各路由处理器里（Node 运行时，能读库）。
 * `/api/v1/*` 不在这里拦：助手走 Bearer token，交给 `requireApiAuth` 判（并给出 401 而不是跳登录页）。
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/** 放行名单：登录页本身就是入口（首次启动的「设置密码」也在这一页里，没有单独的 /setup 路由） */
const PUBLIC_PATHS = ["/login"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();
  // 所有接口自己做认证：/api/v1/* 走 Bearer token 或 session（返回 401 而不是跳登录页），
  // /api/auth 是登录入口本身 —— 拦它会导致"登录请求被重定向到登录页"这种死循环。
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    // 开发环境没配 SESSION_SECRET 时不做页面拦截（服务端会生成临时密钥）
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, secret);
  if (session) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 放行名单 = 静态资源 + PWA 的三样。PWA 那三样不是"顺手加的"，少一个就会坏：
  //   sw.js                —— 浏览器注册 Service Worker 时是**先取脚本再做登录判断**的，
  //                           被 307 到 /login 会让注册直接失败（拿到的是 HTML 不是 JS）；
  //   manifest.webmanifest —— 同上，否则手机加到主屏时读不到清单；
  //   ~offline             —— 离线兜底页要能被 SW 预缓存下来。若它被拦，
  //                           预缓存抓到的是一张登录页，断网时点开 App 会要求先登录。
  // 这三样都是不含任何数据的静态内容，放行不影响 NFR-4 的单用户登录。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|~offline|icons/).*)",
  ],
};
