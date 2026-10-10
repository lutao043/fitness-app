/**
 * 幂等写入口 · settings（issue #26 从 `db/writes.ts` 按领域拆出；语义与拆分前逐字一致）。
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { LoadSemantics } from "@/lib/exercise/types";

/* ———————————————————————— 设置与元信息 ———————————————————————— */

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value } })
    .run();
}

export function getMeta(db: Db, key: string): string | null {
  return db.select().from(schema.appMeta).where(eq(schema.appMeta.key, key)).get()?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.insert(schema.appMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appMeta.key, set: { value } })
    .run();
}

export function setUserPassword(db: Db, passwordHash: string): void {
  const u = db.select().from(schema.user).orderBy(schema.user.id).get();
  if (!u) {
    db.insert(schema.user).values({ nickname: "我", passwordHash }).run();
    return;
  }
  db.update(schema.user).set({ passwordHash }).where(eq(schema.user.id, u.id)).run();
}

/**
 * 助手接口 token 的 argon2 哈希（需求书第 7 章：单用户 token，设置页可重置）。
 * `null` = 清掉库里的 token（`.env` 的 `API_TOKEN` 是另一条路，由 `requireApiAuth` 先看它）。
 */
export function setApiTokenHash(db: Db, apiTokenHash: string | null): void {
  const u = db.select().from(schema.user).orderBy(schema.user.id).get();
  if (!u) {
    if (apiTokenHash === null) return; // 还没有 user 行（没设过密码），清空无事可做
    db.insert(schema.user).values({ nickname: "我", apiTokenHash }).run();
    return;
  }
  db.update(schema.user).set({ apiTokenHash }).where(eq(schema.user.id, u.id)).run();
}

export type { LoadSemantics };
