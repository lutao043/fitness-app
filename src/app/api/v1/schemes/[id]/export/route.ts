/**
 * GET /api/v1/schemes/{id}/export —— 导出一套方案（FR-54）。
 *
 * 动作按**名字**引用（id 是本地的，换设备就对不上）；两个场景的清单与目标组数次数都带上。
 * 导入端在 `POST /api/v1/schemes/import`，两边共用 `server/rules.ts` 的 kind / version 约定。
 */

import { getDb } from "@/db/client";
import { schemesAdmin } from "@/db/queries";
import { requireApiAuth } from "@/server/auth";
import { json, notFound } from "@/server/http";
import { SCHEME_EXPORT_KIND, SCHEME_EXPORT_VERSION } from "@/server/rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id } = await ctx.params;
  const scheme = schemesAdmin(getDb()).find((s) => s.id === id);
  if (!scheme) return notFound("方案不存在");

  const toList = (rows: { name: string; targetSets: number; targetReps: number }[]) =>
    rows.map((e) => ({ name: e.name, sets: e.targetSets, reps: e.targetReps }));

  return json({
    kind: SCHEME_EXPORT_KIND,
    version: SCHEME_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    name: scheme.name,
    note: scheme.note,
    slots: scheme.slots.map((slot) => ({
      label: slot.label,
      rest: slot.rest,
      muscles: slot.muscles,
      gym: toList(slot.gym),
      home: toList(slot.home),
    })),
  });
}
