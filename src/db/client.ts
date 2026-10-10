/**
 * SQLite 连接（需求书第 9 章：better-sqlite3 + WAL）。
 *
 * - 单进程串行写入，不需要连接池（第 9 章第 1 条）；
 * - 库文件放 `DATA_DIR`（容器里挂 `./data`，NFR-1）；
 * - 启动时跑 drizzle 迁移 + 种子（种子只注入一次，13.12）；
 * - 开发环境 HMR 会反复执行模块，用 globalThis 守卫住单例（第 9 章第 12 条同源思路）。
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { seedOnce } from "./seed";

export type Db = BetterSQLite3Database<typeof schema>;

interface DbHolder {
  sqlite: Database.Database;
  db: Db;
}

const globalForDb = globalThis as unknown as { __fitnessDb?: DbHolder };

export function dataDir(): string {
  return resolve(process.env.DATA_DIR ?? "./data");
}

export function databaseFile(): string {
  return process.env.DATABASE_FILE ?? resolve(dataDir(), "fitness.sqlite");
}

function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), "drizzle");
}

function init(): DbHolder {
  const file = databaseFile();
  mkdirSync(resolve(file, ".."), { recursive: true });
  const sqlite = new Database(file);
  // WAL：练中每组都落库，频率极低；WAL 让读写不互相阻塞（第 9 章第 1 条）
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  seedOnce(db);

  return { sqlite, db };
}

export function getDbHolder(): DbHolder {
  if (!globalForDb.__fitnessDb) {
    globalForDb.__fitnessDb = init();
  }
  return globalForDb.__fitnessDb;
}

export function getDb(): Db {
  return getDbHolder().db;
}

export function getSqlite(): Database.Database {
  return getDbHolder().sqlite;
}

/** 测试与脚本用：开一个独立的库（不碰全局单例） */
export function openDatabase(file: string, runSeed = true): DbHolder {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  if (runSeed) seedOnce(db);
  return { sqlite, db };
}
