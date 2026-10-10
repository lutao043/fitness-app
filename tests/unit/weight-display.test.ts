/**
 * 重量次要区与措辞（issue #35 / v1.37）。
 *
 * 两件事：
 * 1. **按动作类型说人话** —— 器械动作不能写「每侧」（那本身就是错的措辞）；
 * 2. **不填 = null，空 ≠ 0** —— 空读数不计容量，也不能凭空算出"只有杠重的 20 kg"。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_BAR_KG,
  totalLoadKg,
  weightLabel,
  weightReadHint,
  weightSummaryText,
} from "@/lib/caliber";
import { volumeText } from "@/lib/units";

const dir = mkdtempSync(join(tmpdir(), "fitness-weight-"));
process.env.DATABASE_FILE = join(dir, "weight.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

function req(method: string, path: string, body?: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterAll(async () => {
  try {
    const { getSqlite } = await import("@/db/client");
    getSqlite().close();
  } catch {
    // 没打开过就忽略
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("按动作类型说人话（issue #35 验收 1/2/3）", () => {
  it("器械 / 绳索：「每侧」不再出现，改说器械读数", () => {
    expect(weightLabel("machine", "direct", "kg")).toBe("重量（kg，器械读数）");
    expect(weightLabel("machine", "ratio_2to1", "lb")).toBe("重量（lb，器械读数）");
    expect(weightLabel("machine", "direct", "kg")).not.toContain("每侧");
  });

  it("杠铃每侧 / 哑铃每只 / 单侧动作一侧 / 自重标注加重", () => {
    expect(weightLabel("barbell", "direct", "kg")).toBe("重量（每侧 kg）");
    expect(weightLabel("dumbbell", "direct", "kg")).toBe("重量（每只 kg）");
    expect(weightLabel("single_side", "direct", "kg")).toBe("重量（一侧 kg）");
    expect(weightLabel("bodyweight", "direct", "kg")).toBe("加重（kg，可不填）");
  });

  it("助力 / 弹力带说清读数含义（它们不计容量）", () => {
    expect(weightLabel("machine", "assist", "kg")).toContain("助力");
    expect(weightLabel("machine", "assist", "kg")).toContain("越大越省力");
    expect(weightLabel("machine", "band", "kg")).toContain("弹力带");
  });

  it("变体面板的短提示与上面同源", () => {
    expect(weightReadHint("barbell", "direct")).toBe("每侧");
    expect(weightReadHint("dumbbell", "direct")).toBe("每只");
    expect(weightReadHint("single_side", "direct")).toBe("一侧");
    expect(weightReadHint("machine", "direct")).toBe("器械读数");
    expect(weightReadHint("machine", "ratio_2to1")).toBe("器械读数（2:1）");
    expect(weightReadHint("machine", "assist")).toBe("助力读数");
  });

  it("摘要行：没填说「未填 · 可不填」，不会借上一组的重量充数", () => {
    expect(weightSummaryText(null, "kg")).toBe("未填 · 可不填");
    expect(weightSummaryText(undefined, "kg")).toBe("未填 · 可不填");
    expect(weightSummaryText(120, "kg")).toBe("120 kg · 可不填");
    expect(weightSummaryText(20.4, "lb")).toBe("45 lb · 可不填"); // 库里是 kg，展示按 lb 换算
  });
});

describe("空读数不计容量（issue #35 验收 6：空 ≠ 0）", () => {
  it("空读数的杠铃动作不会算出「只有杠重 20 kg」", () => {
    expect(totalLoadKg({ weightKg: null, loadMode: "barbell" })).toBeNull();
    expect(totalLoadKg({ weightKg: null, loadMode: "barbell", barKg: DEFAULT_BAR_KG })).toBeNull();
    expect(totalLoadKg({ weightKg: undefined, loadMode: "dumbbell" })).toBeNull();
    expect(totalLoadKg({ weightKg: null, loadMode: "machine" })).toBeNull();
    expect(totalLoadKg({ weightKg: 0, loadMode: "barbell" })).toBeNull(); // 0 也当"没上重量"
  });

  it("填了读数才折算（13.1 的基准例子不受影响）", () => {
    expect(totalLoadKg({ weightKg: 20, loadMode: "barbell" })).toBe(60);
    expect(totalLoadKg({ weightKg: 20, loadMode: "dumbbell" })).toBe(40);
    expect(totalLoadKg({ weightKg: 20, loadMode: "machine" })).toBe(20);
    expect(totalLoadKg({ weightKg: 20, loadMode: "single_side" })).toBe(20);
  });

  it("容量文案：没有一点重量数据时给「—」，不显示 0 kg（验收 2）", () => {
    expect(volumeText(0, "kg")).toBe("—");
    expect(volumeText(null, "kg")).toBe("—");
    expect(volumeText(undefined, "kg")).toBe("—");
    expect(volumeText(5160, "kg")).toBe("5160");
  });
});

describe("接口级：不填重量照记，容量为 0（issue #35 验收 1）", () => {
  let sessionId = 0;
  let exerciseId = 0;

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // 挑一个杠铃动作（最能暴露"空读数凭空造出杠重 20 kg"）
    const row =
      getDb()
        .select({ id: schema.exercise.id, loadMode: schema.exercise.loadMode })
        .from(schema.exercise)
        .where(eq(schema.exercise.loadMode, "barbell"))
        .limit(1)
        .get() ??
      getDb()
        .select({ id: schema.exercise.id, loadMode: schema.exercise.loadMode })
        .from(schema.exercise)
        .limit(1)
        .get();
    exerciseId = Number(row?.id ?? 0);
    const { POST } = await import("@/app/api/v1/sessions/route");
    const res = await POST(
      req("POST", "/api/v1/sessions", {
        client_id: "weight-optional-1",
        part: "胸+三头",
        mode: "gym",
        status: "doing",
        started_at: "2026-10-09T09:00:00.000Z",
      }),
    );
    sessionId = Number((await jsonOf(res)).id);
  });

  it("完全不碰重量：weight_kg / total_load_kg 都是 null、容量 0，但组数照记", async () => {
    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "weight-optional-1:1:d:1",
        exercise_id: exerciseId,
        set_no: 1,
        reps: 12,
        done_at: "2026-10-09T09:02:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.totalLoadKg).toBeNull();
    expect(body.volumeKg).toBe(0);

    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const row = getDb()
      .select({ weightKg: schema.setLog.weightKg, totalLoadKg: schema.setLog.totalLoadKg, reps: schema.setLog.reps })
      .from(schema.setLog)
      .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.setNo, 1)))
      .get();
    expect(row?.weightKg).toBeNull();
    expect(row?.totalLoadKg).toBeNull();
    expect(row?.reps).toBe(12); // 次数照记
  });
});
