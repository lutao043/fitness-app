/**
 * POST /api/v1/skip —— 今天不练（顺延），`{date, reason}`；同日只此一条，重复调用 = no-op（第 7 章）。
 *   `reason` ∈ `missed | overtime | holiday | manual`（缺省 missed）；非法值 **400**（13.8，v1.26）。
 *
 * 欠账上限（13.8）：要写第 3 条 skip_day 之前**先问重锚**——
 * 接口在这里返回 `needs_reanchor: true` 并**不写入**（除非调用方显式带 `confirm: true`）。
 */

import { getDb } from "@/db/client";
import { ensureSkip } from "@/db/writes";
import { loadScheduleState, lastRecordDate } from "@/db/queries";
import { isTrainingDay, owedParts } from "@/lib/schedule";
import { requireApiAuth } from "@/server/auth";
import { parseSkipBody } from "@/server/rules";
import { badRequest, readJsonBody, writeJson } from "@/server/http";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  // reason 白名单、date 格式都收敛在 server/rules.ts（13.19 的范围表）
  const skip = parseSkipBody(parsed.body, { defaultDate: dateInTz() });
  if (!skip.ok) return badRequest(skip.issues.join("；"), undefined, request);
  const { date, reason, confirm } = skip.value;

  const db = getDb();
  const state = loadScheduleState(db, date);
  // 休息日 / 假期不写顺延（与踩坑第 37 条同一条理由）：那天本来就不练，顺延等于什么都没做、
  // 却会白记一笔欠账。界面本来就不给按钮，这里把接口也挡上 —— 免得助手 / 手搓请求漏进来。
  if (state.holidaySet.has(date) || !isTrainingDay(date, state.ctx, state.slots)) {
    return badRequest("那天本来就不练（休息日 / 假期）：不需要顺延", undefined, request);
  }
  const owed = owedParts(date, state.ctx, state.slots, lastRecordDate(db));
  const wouldExceed = owed.length + 1 > 2;

  if (wouldExceed && !confirm) {
    // 先问重锚（FR-38）：接受 → 以今天重锚、欠账清零；拒绝 → 调用方带 confirm 再写
    return writeJson(request, 
      {
        written: false,
        needs_reanchor: true,
        owed: owed.map((o) => ({ date: o.date, part: o.part })),
        message: "已经欠 2 个部位了。要不要以今天重锚、把欠账清零？（拒绝就照写顺延）",
      },
      { status: 409 },
    );
  }

  const result = ensureSkip(db, { date, reason, note: skip.value.note });
  return writeJson(request, { written: result.created, id: result.id, date, reason }, { status: result.created ? 201 : 200 });
}
