/**
 * POST /api/v1/body-analysis —— 写「每日体重分析」（FR-57 / v1.29）
 *   `{date?, level, text}`；`date` 缺省 = 今天。**同一天重复写 = 覆盖（幂等）**。
 *   `source` 固定 `assistant`（服务端写死，不收调用方的值）。
 * GET  /api/v1/body-analysis?limit=30 —— 最近 N 条（按日期倒序），身体页「趋势解读」用。
 *
 * 为什么写在服务端而不是让 App 生成：归因要看上下文（训练记录、加班、放纵餐、称重时点、体脂/水分方向）
 * 且要看趋势而不是单点 —— 那是助手侧的事；App 侧**不接 LLM、不生成文案**（issue #6 的边界）。
 * 网页上没有生成 / 编辑入口：与假期表、助手 token 一样，**助手写入、网页只读**。
 */

import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { upsertBodyAnalysis } from "@/db/writes";
import { requireApiAuth } from "@/server/auth";
import { parseBodyAnalysisBody } from "@/server/rules";
import { badRequest, json, readJsonBody, writeJson } from "@/server/http";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 90;
const DEFAULT_LIMIT = 30;

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // level 白名单 / text 长度 / date 格式都收敛在 server/rules.ts（13.19 的范围表）
  const analysis = parseBodyAnalysisBody(parsed.body, { defaultDate: dateInTz() });
  if (!analysis.ok) return badRequest(analysis.issues.join("；"), undefined, request);

  const result = upsertBodyAnalysis(getDb(), analysis.value);
  return writeJson(request, { ...result, level: analysis.value.level }, { status: result.created ? 201 : 200 });
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const raw = url.searchParams.get("limit");
  const limit = raw === null || raw === "" ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return badRequest(`limit 必须是 1~${MAX_LIMIT} 的整数`, undefined, request);
  }

  const items = getDb()
    .select()
    .from(schema.bodyAnalysis)
    .orderBy(desc(schema.bodyAnalysis.date))
    .limit(limit)
    .all();

  return json({ limit, items });
}
