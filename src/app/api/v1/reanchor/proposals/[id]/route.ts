/**
 * POST /api/v1/reanchor/proposals/{id} —— 接受 / 拒绝重锚建议（FR-38）。
 *
 * - **接受** → 以今天（或传入 date）重锚、欠账清零（暂停期不产生欠账）；
 * - **拒绝** → 排期不变；本次暂停期内（到出现新的训练记录为止）不再重复问。
 */

import { getDb } from "@/db/client";
import { activeSchemeId, appendAnchor, decideAnchorProposal } from "@/db/writes";
import { proposalById } from "@/server/reanchor";
import { requireApiAuth } from "@/server/auth";
import { asNumber, asString, badRequest, notFound, oneOf, readJsonBody, writeJson } from "@/server/http";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) return badRequest("建议 id 不合法", undefined, request);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const decision = oneOf(body.decision, ["accept", "reject"] as const);
  if (!decision) return badRequest('decision 只能是 "accept" 或 "reject"', undefined, request);

  const db = getDb();
  const proposal = proposalById(db, id);
  if (!proposal) return notFound("建议不存在或已处理");

  if (decision === "reject") {
    decideAnchorProposal(db, id, "rejected");
    return writeJson(request, { id, status: "rejected", anchorChanged: false });
  }

  const position = asNumber(body.cycle_position ?? body.cyclePosition) ?? proposal.suggestedPosition;
  appendAnchor(db, {
    schemeId: activeSchemeId(db),
    anchorDate: asString(body.date) ?? dateInTz(),
    cyclePosition: position,
    reason: "pause_resume",
    note: `接受重锚建议 #${id}`,
  });
  decideAnchorProposal(db, id, "accepted");
  return writeJson(request, { id, status: "accepted", anchorChanged: true, cyclePosition: position });
}
