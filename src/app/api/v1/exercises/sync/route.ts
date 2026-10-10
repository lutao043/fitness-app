/**
 * 内置动作库补齐（v1.22，FR-21 的补充入口）：
 * - GET  —— 预览：内置库里这台设备还没有的动作名（只读，不改库）
 * - POST —— 补齐：把缺失的内置动作**按名字**补进库（只新增，不修改、不删除）
 *
 * 为什么需要这个入口：种子**只注入一次**（13.12），动作库扩充之后已经装过的设备不会自己长出新动作；
 * 生产环境又不给 shell（不开 SSH、不放源码），所以「补齐」放在网页里由用户点一下完成。
 * 只新增、不覆盖 —— 你改过名 / 调过参数的动作一个字都不会被动。
 */

import { EXERCISES } from "@/data";
import { getDb } from "@/db/client";
import { missingBuiltinExercises, syncBuiltinExerciseLibrary } from "@/db/seed";
import { requireApiAuth } from "@/server/auth";
import { json, writeJson } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const missing = missingBuiltinExercises(getDb());
  return json({ total: EXERCISES.length, missing });
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const result = syncBuiltinExerciseLibrary(getDb());
  return writeJson(request, { ...result, missing: missingBuiltinExercises(getDb()) });
}
