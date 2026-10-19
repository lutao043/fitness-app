/**
 * GET /api/v1/export.csv —— CSV 导出（FR-46 / 13.13）。
 *
 * - `?type=workout`（训练明细）/ `body`（体重体脂）/ `measurements`（围度）/ `cardio`（有氧分钟数），分开下载；
 * - 一律带 **UTF-8 BOM**（Excel 打开中文不乱码）；列名里写清口径（weight_kg_side 单侧 / total_load_kg 总重）；
 * - 数据与 export.json 同源（server/export-data.ts 的同一套收集），只差序列化形态。
 */

import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { badRequest, oneOf } from "@/server/http";
import { collectExport, type ExportPayload } from "@/server/export-data";
import { dateInTz } from "@/lib/time";

export const dynamic = "force-dynamic";

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvEscape).join(","));
  // UTF-8 BOM：Excel 直接打开中文不乱码（13.13）
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function variantLabel(payload: ExportPayload, variantId: number | null): string {
  if (variantId === null) return "";
  const v = (payload.exerciseVariants as { id: number; equip: string | null; code: string | null }[]).find(
    (x) => x.id === variantId,
  );
  return v ? v.equip ?? v.code ?? `#${variantId}` : `#${variantId}`;
}

export async function GET(request: Request) {
  const auth = await requireApiAuth(request);
  if (!auth.ok) return auth.response!;

  const url = new URL(request.url);
  const type = oneOf(url.searchParams.get("type"), ["workout", "body", "measurements", "cardio"] as const);
  if (!type) return badRequest('type 只能是 "workout" | "body" | "measurements" | "cardio"', undefined, request);

  const db = getDb();
  const today = dateInTz();
  let csv: string;
  if (type === "workout") {
    const payload = collectExport(db);
    const exName = new Map((payload.exercises as { id: number; name: string }[]).map((e) => [e.id, e.name]));
    const sessionById = new Map(
      (payload.sessions as { id: number; date: string; part: string; mode: string; status: string }[]).map((s) => [s.id, s]),
    );
    const sets = payload.sets as {
      sessionId: number;
      exerciseId: number;
      variantId: number | null;
      setNo: number;
      weightKg: number | null;
      reps: number | null;
      durationSec: number | null;
      totalLoadKg: number | null;
      restBeforeSec: number | null;
      sameExercise: number | boolean;
      startedAt: string | null;
      doneAt: string;
      feel: string | null;
      skipped: number | boolean;
      isWarmup: number | boolean;
    }[];
    const rows = sets.map((s) => {
      const sess = sessionById.get(s.sessionId);
      return [
        sess?.date ?? "",
        sess?.part ?? "",
        sess?.mode ?? "",
        sess?.status ?? "",
        exName.get(s.exerciseId) ?? `#${s.exerciseId}`,
        variantLabel(payload, s.variantId),
        s.setNo,
        s.weightKg,
        s.reps,
        s.durationSec,
        s.totalLoadKg,
        s.restBeforeSec,
        s.sameExercise ? 1 : 0,
        s.skipped ? 1 : 0,
        s.isWarmup ? 1 : 0,
        s.doneAt,
        s.startedAt,
        s.feel ?? "",
      ];
    });
    csv = toCsv(
      [
        "date",
        "part",
        "mode",
        "status",
        "exercise",
        "variant",
        "set_no",
        "weight_kg_side",
        "reps",
        "duration_sec",
        "total_load_kg",
        "rest_before_sec",
        "same_exercise",
        "skipped",
        "is_warmup",
        "done_at",
        "started_at",
        "feel",
      ],
      rows,
    );
  } else if (type === "body") {
    const rows = db
      .select()
      .from(schema.bodyMetric)
      .all()
      .map((r) => [r.date, r.slot, r.weightKg, r.bodyFatPct ?? "", r.note ?? "", r.createdAt]);
    csv = toCsv(["date", "slot", "weight_kg", "body_fat_pct", "note", "created_at"], rows);
  } else if (type === "cardio") {
    // 有氧（FR-50）：只记分钟数（形式固定爬坡走）；不算出勤、不进容量（13.4）
    const rows = db
      .select()
      .from(schema.cardioLog)
      .all()
      .map((r) => [r.date, r.minutes, r.note ?? "", r.createdAt]);
    csv = toCsv(["date", "minutes", "note", "created_at"], rows);
  } else {
    const rows = db
      .select()
      .from(schema.measurement)
      .all()
      .map((r) => [r.date, r.waistCm ?? "", r.chestCm ?? "", r.armCm ?? "", r.thighCm ?? ""]);
    csv = toCsv(["date", "waist_cm", "chest_cm", "arm_cm", "thigh_cm"], rows);
  }

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="fitness-${type}-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
