/**
 * 备份（NFR-5 / 13.13）。
 *
 * **禁止直接复制 `.sqlite` 文件**：WAL 模式下会拿到不含最新事务的快照。
 * 一律用 `VACUUM INTO`（SQLite 官方给的一致性快照做法），文件名带日期，保留最近 N 份。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "./client";
import { dataDir } from "./client";
import { dateInTz, timeInTz } from "@/lib/time";

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: number;
}

export function backupsDir(): string {
  return resolve(process.env.BACKUP_DIR ?? join(dataDir(), "backups"));
}

export function backupFileFor(now: Date = new Date()): string {
  return join(backupsDir(), `fitness-${dateInTz(now)}-${timeInTz(now).replace(":", "")}.sqlite`);
}

/** 生成一份一致性快照；同一天重复调用会各留一份（时间戳不同），保留期按份数控制 */
export function makeBackup(db: Db, now: Date = new Date(), keep = 30): BackupResult {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const file = backupFileFor(now);
  if (existsSync(file)) rmSync(file, { force: true });
  // VACUUM INTO 不接受参数占位符，路径要自己转义（单引号翻倍）
  db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'` as never);

  const pruned = pruneBackups(keep);
  return { file, bytes: statSync(file).size, pruned };
}

/** 只保留最近 keep 份（按文件名里的日期时间排序） */
export function pruneBackups(keep = 30): number {
  const dir = backupsDir();
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("fitness-") && f.endsWith(".sqlite"))
    .sort();
  let pruned = 0;
  while (files.length > keep) {
    const victim = files.shift();
    if (!victim) break;
    rmSync(join(dir, victim), { force: true });
    pruned++;
  }
  return pruned;
}

export function listBackups(): { file: string; bytes: number; mtime: string }[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("fitness-") && f.endsWith(".sqlite"))
    .sort()
    .reverse()
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: f, bytes: st.size, mtime: st.mtime.toISOString() };
    });
}
