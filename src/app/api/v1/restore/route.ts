/**
 * POST /api/v1/restore —— 上传备份恢复（FR-47 / 13.13）。
 *
 * 请求体 = 备份 .sqlite 文件原文（application/octet-stream）。流程按 13.13 严格走：
 *   ① 校验（SQLite 文件头 + `PRAGMA integrity_check` = ok + 关键表齐全 = schema 版本匹配的最低门槛；
 *      更旧的备份由重启后的 drizzle 迁移自动补齐）；
 *   ② 落盘临时文件（data/restore-*.tmp）；
 *   ③ **不得热替换**正在使用的库 —— 关闭当前连接 → 清掉旧 WAL/SHM → 原子替换 → 进程退出，
 *      由容器 `restart: unless-stopped` 拉起后用新库（NFR-1）。
 * 校验不过 → 400 带原因，库里一个字节都不动。
 *
 * 测试钩子：`RESTORE_DRY_RUN=1` 时只做①②并返回 applied=false，不关连接不替换（给接口级测试用）。
 * 网页入口在「我的 → 数据与账号」，带二次确认。
 */

import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { getSqlite, databaseFile } from "@/db/client";
import { requireApiAuth } from "@/server/auth";
import { badRequest, writeJson } from "@/server/http";
import { logEvent } from "@/server/logger";

export const dynamic = "force-dynamic";

const SQLITE_MAGIC = "SQLite format 3\0";
const MIN_BYTES = 4096;
const MAX_BYTES = 512 * 1024 * 1024;
/** 合法备份必须有的表（第 6 章 schema 的关键子集；齐全 = 不是别的 SQLite 文件乱充数） */
const REQUIRED_TABLES = [
  "user",
  "split_scheme",
  "cycle_template",
  "exercise",
  "workout_session",
  "set_log",
  "body_metric",
  "measurement",
  "supplement",
  "checkin",
  "reminder_event",
  "app_setting",
  "app_meta",
  "holiday",
];

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const raw = await request.arrayBuffer();
  if (raw.byteLength < MIN_BYTES) return badRequest("文件太小，不是合法的数据库备份", undefined, request);
  if (raw.byteLength > MAX_BYTES) return badRequest("文件超过 512MB，不是本项目的备份", undefined, request);

  const header = Buffer.from(raw.slice(0, 16)).toString("latin1");
  if (header !== SQLITE_MAGIC) return badRequest("文件头不是 SQLite 数据库", undefined, request);

  // ① 落盘临时文件（与库文件同目录，保证 rename 是同盘原子操作）
  const target = databaseFile();
  const tmp = join(resolve(target, ".."), `restore-${Date.now()}.tmp`);
  writeFileSync(tmp, Buffer.from(raw));

  // ② 校验：完整性 + 关键表
  let check: Database.Database;
  try {
    check = new Database(tmp, { readonly: true });
    const integrity = check.pragma("integrity_check", { simple: true }) as unknown;
    if (integrity !== "ok") {
      check.close();
      rmSync(tmp, { force: true });
      return badRequest(`库完整性校验失败：${String(integrity)}`, undefined, request);
    }
    const tables = (check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]).map((r) => r.name);
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      check.close();
      rmSync(tmp, { force: true });
      return badRequest(`不是本项目的备份（缺表：${missing.join("、")}）`, undefined, request);
    }
    check.close();
  } catch (error) {
    rmSync(tmp, { force: true });
    return badRequest(`备份文件无法读取：${error instanceof Error ? error.message : String(error)}`, undefined, request);
  }

  if (process.env.RESTORE_DRY_RUN === "1") {
    rmSync(tmp, { force: true });
    return writeJson(request, { validated: true, applied: false });
  }

  // ③ 热替换禁令（13.13）：关连接 → 清 WAL 残留 → 原子替换 → 退出交由容器拉起
  getSqlite().close();
  const globalForDb = globalThis as unknown as { __fitnessDb?: unknown };
  delete globalForDb.__fitnessDb;
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${target}${suffix}`;
    if (existsSync(side)) rmSync(side, { force: true });
  }
  renameSync(tmp, target);
  logEvent({ event: "restore.applied", detail: `已用上传的备份替换 ${target}，进程退出等待容器重启（restart: unless-stopped）` });
  setTimeout(() => process.exit(0), 500);

  return writeJson(request, { validated: true, applied: true, message: "恢复完成，服务正在重启" });
}
