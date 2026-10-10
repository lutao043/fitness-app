/**
 * GET /api/v1/reanchor/proposals —— 待确认的重锚建议列表（FR-38）。
 * 单条的接受 / 拒绝在 `proposals/[id]` 下。
 */

import { getDb } from "@/db/client";
import { pendingProposals } from "@/server/reanchor";
import { requireApiAuth } from "@/server/auth";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;
  const db = getDb();
  return json({
    proposals: pendingProposals(db).map((p) => ({
      id: p.id,
      date: p.date,
      suggested_position: p.suggestedPosition,
      status: p.status,
      created_at: p.createdAt,
    })),
  });
}
