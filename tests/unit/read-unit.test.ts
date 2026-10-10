/**
 * 变体级读数单位（v1.38 / issue #36）。
 *
 * 口径：**库内一律 kg**（13.1 不动）；变体上的 `read_unit` 只决定"这台器械的读数按什么单位展示与录入"，
 * 空 = 跟随全局设置；**汇总（总容量 / 统计 / 趋势 / 记录页 / 导出）永远跟全局设置**。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asOptionalReadUnit, displayToKg, effectiveReadUnit, kgToDisplay } from "@/lib/units";

const dir = mkdtempSync(join(tmpdir(), "fitness-read-unit-"));
process.env.DATABASE_FILE = join(dir, "read-unit.sqlite");
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

describe("effectiveReadUnit（纯函数）", () => {
  it("变体上配了就用变体上的；没配（老数据 null）跟随全局设置", () => {
    expect(effectiveReadUnit("lb", "kg")).toBe("lb");
    expect(effectiveReadUnit("kg", "lb")).toBe("kg");
    expect(effectiveReadUnit(null, "lb")).toBe("lb");
    expect(effectiveReadUnit(undefined, "kg")).toBe("kg");
    // 脏值一律退回全局（不让展示层拿到第三种单位）
    expect(effectiveReadUnit("LB" as never, "kg")).toBe("kg");
  });

  it("asOptionalReadUnit：null 也是合法值（= 跟随全局）", () => {
    expect(asOptionalReadUnit("kg")).toBe("kg");
    expect(asOptionalReadUnit("lb")).toBe("lb");
    expect(asOptionalReadUnit(null)).toBeNull();
    expect(asOptionalReadUnit("")).toBeNull();
    expect(asOptionalReadUnit("kg ")).toBeNull();
  });

  it("lb → kg → lb 往返稳定（5 / 45 / 33 三个点，issue #36 待拍板第 3 点）", () => {
    for (const lb of [5, 45, 33]) {
      const kg = displayToKg(lb, "lb")!;
      expect(kgToDisplay(kg, "lb")).toBe(lb);
    }
    expect(displayToKg(45, "lb")).toBe(20.41); // 45 lb = 20.41 kg（库里存 2 位小数）
    expect(displayToKg(33, "lb")).toBe(14.97);
  });

  it("kg 侧不受影响：kg 录入仍是 1 位小数", () => {
    expect(displayToKg(20, "kg")).toBe(20);
    expect(displayToKg(22.5, "kg")).toBe(22.5);
    expect(kgToDisplay(20, "kg")).toBe(20);
  });
});

describe("接口级：read_unit 落库与字段透出", () => {
  let exerciseId = 0;
  let variantId = 0;

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    exerciseId = Number(
      getDb().select({ id: schema.exercise.id }).from(schema.exercise).limit(1).get()?.id ?? 0,
    );
    expect(exerciseId).toBeGreaterThan(0);
  });

  it("加变体时配「按 lb 读」→ 存下来、动作库接口带 readUnit", async () => {
    const { POST } = await import("@/app/api/v1/exercises/[id]/variants/route");
    const res = await POST(
      req("POST", `/api/v1/exercises/${exerciseId}/variants`, {
        equip: "器械",
        semantics: "direct",
        label: "美制那台",
        base: null,
        read_unit: "lb",
      }),
      params({ id: String(exerciseId) }),
    );
    expect(res.status).toBe(201);
    variantId = Number((await jsonOf(res)).id);

    const { GET } = await import("@/app/api/v1/exercises/route");
    const lib = await jsonOf(await GET(req("GET", "/api/v1/exercises")));
    const row = (lib.exercises as { id: number; variants: { id: number; readUnit: string | null }[] }[]).find(
      (e) => e.id === exerciseId,
    );
    expect(row?.variants.find((v) => v.id === variantId)?.readUnit).toBe("lb");
  });

  it("非法读数单位 → 400 且不落库", async () => {
    const { POST } = await import("@/app/api/v1/exercises/[id]/variants/route");
    const res = await POST(
      req("POST", `/api/v1/exercises/${exerciseId}/variants`, {
        equip: "器械",
        semantics: "direct",
        read_unit: "斤",
      }),
      params({ id: String(exerciseId) }),
    );
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error) + JSON.stringify(body.issues ?? [])).toContain("读数单位");
  });

  it("PATCH read_unit 为 null = 改回「跟随全局」", async () => {
    const { PATCH } = await import("@/app/api/v1/exercises/[id]/variants/[variantId]/route");
    const res = await PATCH(
      req("PATCH", `/api/v1/exercises/${exerciseId}/variants/${variantId}`, { read_unit: null }),
      params({ id: String(exerciseId), variantId: String(variantId) }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).readUnit).toBeNull();
  });

  it("会话详情与今日清单都把 readUnit 带给页面（否则助手代记会按错单位写数）", async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // 直接改回 lb，看两个读接口是否透出
    getDb()
      .update(schema.exerciseVariant)
      .set({ readUnit: "lb" })
      .where(eq(schema.exerciseVariant.id, variantId))
      .run();

    const { POST: sessPOST, GET: sessGET } = await import("@/app/api/v1/sessions/route");
    const created = await jsonOf(
      await sessPOST(
        req("POST", "/api/v1/sessions", {
          client_id: "read-unit-session",
          part: "胸+三头",
          mode: "gym",
          status: "doing",
          started_at: "2026-10-09T09:00:00.000Z",
        }),
      ),
    );
    const sessionId = Number(created.id);

    // 会话详情：先给会话加一个动作（用带 lb 变体的那个动作）
    const { POST: addEx } = await import("@/app/api/v1/sessions/[id]/exercises/route");
    const added = await jsonOf(
      await addEx(
        req("POST", `/api/v1/sessions/${sessionId}/exercises`, {
          exercise_id: exerciseId,
          target_sets: 3,
          target_reps: 12,
        }),
        params({ id: String(sessionId) }),
      ),
    );
    expect(added).toBeTruthy();

    const { GET: detailGET } = await import("@/app/api/v1/sessions/[id]/route");
    const detail = await jsonOf(
      await detailGET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const ex = (
      detail.exercises as { exerciseId: number; variants: { id: number | null; readUnit: string | null }[] }[]
    ).find((e) => e.exerciseId === exerciseId);
    expect(ex?.variants.find((v) => v.id === variantId)?.readUnit).toBe("lb");

    const { GET: todayGET } = await import("@/app/api/v1/today/route");
    const today = await jsonOf(await todayGET(req("GET", "/api/v1/today")));
    const tdayEx = (
      today.exercises as { exerciseId: number; variants: { id: number | null; readUnit?: string | null }[] }[]
    ).find((e) => e.exerciseId === exerciseId);
    // 今天的清单不一定含这个动作（按排期走），含到了就必须带 readUnit
    if (tdayEx) {
      expect(tdayEx.variants.find((v) => v.id === variantId)?.readUnit).toBe("lb");
    }
    expect(sessGET).toBeTypeOf("function");
  });

  it("老数据（read_unit 全 NULL）行为不变：readUnit 为 null → 跟全局", async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.exerciseVariant)
      .set({ readUnit: null })
      .where(eq(schema.exerciseVariant.id, variantId))
      .run();
    const { GET } = await import("@/app/api/v1/exercises/route");
    const lib = await jsonOf(await GET(req("GET", "/api/v1/exercises")));
    const row = (lib.exercises as { id: number; variants: { id: number; readUnit: string | null }[] }[]).find(
      (e) => e.id === exerciseId,
    );
    expect(row?.variants.find((v) => v.id === variantId)?.readUnit).toBeNull();
    // 生效值回落到全局设置
    expect(effectiveReadUnit(null, "kg")).toBe("kg");
    expect(effectiveReadUnit(null, "lb")).toBe("lb");
  });
});
