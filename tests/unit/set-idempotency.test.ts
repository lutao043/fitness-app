/**
 * 记一组的幂等（第 7 章 / issue #34）：同一组的重复提交只能落一行。
 *
 * 两个入口都要挡住：
 * - 确定性幂等键（新客户端：同 set_no → 同 key）；
 * - 服务端按「会话 × 动作 × 变体 × 组号」兜底（老客户端键尾带时间戳，两次点击算出两个键）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setClientKey } from "@/lib/set-key";

const dir = mkdtempSync(join(tmpdir(), "fitness-set-idem-"));
process.env.DATABASE_FILE = join(dir, "idem.sqlite");
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

describe("setClientKey（纯函数）", () => {
  it("同一个 set_no 反复算都是同一个键（不许掺「每次都在变」的值）", () => {
    const a = setClientKey({ clientId: "sess-1", exerciseId: 7, variantId: null, setNo: 3 });
    const b = setClientKey({ clientId: "sess-1", exerciseId: 7, variantId: null, setNo: 3 });
    expect(a).toBe(b);
    expect(a).toBe("sess-1:7:d:3");
  });

  it("组号 / 动作 / 变体任一不同 → 不同键，且默认变体用 d 占位", () => {
    const base = { clientId: "sess-1", exerciseId: 7, variantId: null };
    expect(setClientKey({ ...base, setNo: 1 })).not.toBe(setClientKey({ ...base, setNo: 2 }));
    expect(setClientKey({ ...base, setNo: 1 })).not.toBe(
      setClientKey({ ...base, exerciseId: 8, setNo: 1 }),
    );
    expect(setClientKey({ ...base, setNo: 1 })).not.toBe(
      setClientKey({ clientId: "sess-1", exerciseId: 7, variantId: 12, setNo: 1 }),
    );
    expect(setClientKey({ ...base, variantId: 12, setNo: 1 })).toBe("sess-1:7:12:1");
  });
});

describe("服务端兜底（接口级）", () => {
  let sessionId = 0;
  let exerciseId = 0;

  async function countRows(setNo: number) {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = getDb()
      .select({ id: schema.setLog.id })
      .from(schema.setLog)
      .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.setNo, setNo)))
      .all();
    return rows.length;
  }

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    exerciseId = Number(
      getDb().select({ id: schema.exercise.id }).from(schema.exercise).limit(1).get()?.id ?? 0,
    );
    const { POST } = await import("@/app/api/v1/sessions/route");
    const res = await POST(
      req("POST", "/api/v1/sessions", {
        client_id: "idem-session-1",
        part: "胸+三头",
        mode: "gym",
        status: "doing",
        started_at: "2026-10-09T09:00:00.000Z",
      }),
    );
    sessionId = Number((await jsonOf(res)).id);
  });

  it("连点两下（老客户端：两个不同的键、同一个 set_no）→ 库里只有 1 条，第二次 created=false", async () => {
    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const body = (key: string) => ({
      client_key: key,
      exercise_id: exerciseId,
      set_no: 1,
      weight_kg: 20,
      reps: 12,
      done_at: "2026-10-09T09:01:00.000Z",
    });

    const first = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, body("idem-session-1:1:d:1:111")),
      params({ id: String(sessionId) }),
    );
    expect(first.status).toBe(201);
    expect((await jsonOf(first)).created).toBe(true);

    const second = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, body("idem-session-1:1:d:1:222")),
      params({ id: String(sessionId) }),
    );
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).created).toBe(false);
    expect(await countRows(1)).toBe(1);
  });

  it("同一确定性键重放两次 → 覆盖同一行（现有语义不回归）", async () => {
    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const key = setClientKey({ clientId: "idem-session-1", exerciseId, variantId: null, setNo: 2 });
    const body = {
      client_key: key,
      exercise_id: exerciseId,
      set_no: 2,
      weight_kg: 30,
      reps: 10,
      done_at: "2026-10-09T09:05:00.000Z",
    };
    const first = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, body),
      params({ id: String(sessionId) }),
    );
    expect(first.status).toBe(201);
    const second = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, { ...body, weight_kg: 32.5 }),
      params({ id: String(sessionId) }),
    );
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).created).toBe(false);
    expect(await countRows(2)).toBe(1);

    // 改组语义：读数被后一次覆盖
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const row = getDb()
      .select({ weightKg: schema.setLog.weightKg, clientKey: schema.setLog.clientKey })
      .from(schema.setLog)
      .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.setNo, 2)))
      .get();
    expect(row?.weightKg).toBe(32.5);
    expect(row?.clientKey).toBe(key);
  });

  it("不同 set_no 正常连记 → 组号连续、不跳号、不合并", async () => {
    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    for (const setNo of [3, 4]) {
      const res = await POST(
        req("POST", `/api/v1/sessions/${sessionId}/sets`, {
          client_key: setClientKey({ clientId: "idem-session-1", exerciseId, variantId: null, setNo }),
          exercise_id: exerciseId,
          set_no: setNo,
          weight_kg: 20,
          reps: 8,
          done_at: `2026-10-09T09:1${setNo}:00.000Z`,
        }),
        params({ id: String(sessionId) }),
      );
      expect(res.status).toBe(201);
    }
    expect(await countRows(3)).toBe(1);
    expect(await countRows(4)).toBe(1);
  });

  it("兜底只在「同组」上生效：换成另一个变体 = 另一组，照常新增", async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const variant = getDb()
      .select({ id: schema.exerciseVariant.id })
      .from(schema.exerciseVariant)
      .where(eq(schema.exerciseVariant.exerciseId, exerciseId))
      .get();
    if (!variant) return; // 这个动作没有变体就跳过（种子数据的差异，不影响兜底结论）

    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: setClientKey({ clientId: "idem-session-1", exerciseId, variantId: variant.id, setNo: 1 }),
        exercise_id: exerciseId,
        variant_id: variant.id,
        set_no: 1,
        weight_kg: 20,
        reps: 12,
        done_at: "2026-10-09T09:20:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).created).toBe(true);
    expect(await countRows(1)).toBe(2); // 默认变体那条 + 这个变体这条
  });
});
