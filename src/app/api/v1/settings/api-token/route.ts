/**
 * 助手接口 token（需求书第 7 章 / D2：「单用户 token，**设置页可重置**」）。
 *
 * - GET    —— 只回状态（有没有配、是环境变量还是库里生成的），**不回 token 本身**；
 * - POST   —— 生成一个新 token（24 字节随机，argon2 哈希入库）—— 明文只在这一次响应里出现，
 *              库与日志里都只有哈希，页面关掉就找不回来了；
 * - DELETE —— 清掉库里那个（`.env` 的 `API_TOKEN` 不受影响，部署侧的东西不该被网页改）。
 *
 * 校验顺序在 `requireApiAuth`：先认 `API_TOKEN` 环境变量，再认库里的哈希 —— 所以
 * 「生成新 token」不会把环境变量那条路顶掉，页面上会分别说明。
 */

import { randomBytes } from "node:crypto";
import { getDb, type Db } from "@/db/client";
import { setApiTokenHash } from "@/db/writes";
import { requireApiAuth, userRow } from "@/server/auth";
import { hashPassword } from "@/lib/auth/password";
import { json, writeJson } from "@/server/http";
import { logEvent, requestContext } from "@/server/logger";

export const dynamic = "force-dynamic";

function tokenStatus(db: Db) {
  return {
    envConfigured: !!process.env.API_TOKEN,
    dbConfigured: !!userRow(db)?.apiTokenHash,
  };
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  return json(tokenStatus(getDb()));
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  const token = randomBytes(24).toString("base64url");
  setApiTokenHash(db, await hashPassword(token));
  // 只记"换过 token"这件事，token 本身与请求体都不进日志（NFR-10）
  logEvent({ event: "auth.api_token", status: 200, detail: "regenerated", ...requestContext(request) });
  return writeJson(request, { token, ...tokenStatus(db) }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const db = getDb();
  setApiTokenHash(db, null);
  logEvent({ event: "auth.api_token", status: 200, detail: "cleared", ...requestContext(request) });
  return writeJson(request, tokenStatus(db));
}
