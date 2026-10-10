/**
 * GET /api/v1/export.json —— 全量导出（FR-46 / 13.13）。
 *
 * 数据收集在 server/export-data.ts（与 CSV 导出共用同一套序列化口径 —— 13.13）：
 * 单位与口径列写清（kg / 单侧 / 总重），时间一律 ISO（Asia/Shanghai 的 date 字段单独给出）。
 */

import { getDb } from "@/db/client";
import { requireApiAuth } from "@/server/auth";
import { json } from "@/server/http";
import { collectExport } from "@/server/export-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  return json(collectExport(getDb()));
}
