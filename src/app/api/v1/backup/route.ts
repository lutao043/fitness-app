/**
 * GET /api/v1/backup —— 下载数据库备份（FR-47 / NFR-5 / 13.13）。
 *
 * **禁止直接复制 .sqlite 文件**（WAL 下会拿到不含最新事务的快照）—— 走 `db/backup.ts` 的
 * `VACUUM INTO` 一致性快照（下载的这份同时留在容器的 `data/backups`，受 30 份保留期管理），
 * 文件名自带日期。上传恢复在 `POST /api/v1/restore`。
 */

import { readFileSync } from "node:fs";
import { getDb } from "@/db/client";
import { makeBackup } from "@/db/backup";
import { requireApiAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const backup = makeBackup(getDb());
  const bytes = readFileSync(backup.file);
  const filename = backup.file.replace(/\\/g, "/").split("/").at(-1) ?? "fitness-backup.sqlite";

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}
