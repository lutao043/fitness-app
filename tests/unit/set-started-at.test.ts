/**
 * 组间歇的"本组开始"= started_at（FR-9 v1.50 / issue #75，接口级）。
 *
 * 线上证据（`GET /api/v1/sessions/5`）：引体向上 4 组的 restBeforeSec = null / 3 / 147 / 175，
 * 后两组都含了本组自己的做组耗时 —— 因为写入口以前传的是 done_at（本组完成）。
 * 这里把四条路都钉住：有点开始 / 忘点开始 / 补录 / 幂等重放。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-set-started-"));
process.env.DATABASE_FILE = join(dir, "started.sqlite");
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

describe("started_at → rest_before_sec（接口级）", () => {
  let sessionId = 0;
  let exerciseId = 0;

  /** 库里这一组落下的行（只看判定要用的三列） */
  async function rowOf(setNo: number) {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    return getDb()
      .select({
        startedAt: schema.setLog.startedAt,
        restBeforeSec: schema.setLog.restBeforeSec,
        sameExercise: schema.setLog.sameExercise,
      })
      .from(schema.setLog)
      .where(and(eq(schema.setLog.sessionId, sessionId), eq(schema.setLog.setNo, setNo)))
      .get();
  }

  async function postSet(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    return POST(req("POST", `/api/v1/sessions/${sessionId}/sets`, body), params({ id: String(sessionId) }));
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
        client_id: "started-session-1",
        part: "胸+三头",
        mode: "gym",
        status: "doing",
        started_at: "2026-10-15T09:00:00.000Z",
      }),
    );
    sessionId = Number((await jsonOf(res)).id);
  });

  it("第 1 组：没有上一组 → rest_before_sec = null（原有语义不回归）", async () => {
    const res = await postSet({
      exercise_id: exerciseId,
      set_no: 1,
      weight_kg: 20,
      reps: 12,
      started_at: "2026-10-15T09:00:30.000Z",
      done_at: "2026-10-15T09:01:00.000Z",
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.restBeforeSec).toBeNull();
    expect((await rowOf(1))?.startedAt).toBe("2026-10-15T09:00:30.000Z");
  });

  it("有点开始：休息 90s、做组 40s → rest_before_sec = 90（不是 130，验收 4）", async () => {
    // 上一组 09:01:00 完成 → 09:02:30 开始做本组（歇 90s）→ 09:03:10 记下（做了 40s）
    const res = await postSet({
      exercise_id: exerciseId,
      set_no: 2,
      weight_kg: 20,
      reps: 10,
      started_at: "2026-10-15T09:02:30.000Z",
      done_at: "2026-10-15T09:03:10.000Z",
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.restBeforeSec).toBe(90); // 旧口径（传 done_at）会给 130
    expect(body.sameExercise).toBe(true);
    expect((await rowOf(2))?.restBeforeSec).toBe(90);
  });

  it("忘点开始：照旧能落库（不报错、不留空组），这一组 rest_before_sec = null（验收 5）", async () => {
    const res = await postSet({
      exercise_id: exerciseId,
      set_no: 3,
      weight_kg: 20,
      reps: 8,
      done_at: "2026-10-15T09:04:00.000Z",
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    // 没有真实间隔 → null，不退回"完成 − 完成"的旧算法（13.5 v1.50）
    expect(body.restBeforeSec).toBeNull();
    // same_exercise 与时间无关，照常判定（历史行展示要用）
    expect(body.sameExercise).toBe(true);
    const row = await rowOf(3);
    expect(row?.startedAt).toBeNull();
    expect(row?.restBeforeSec).toBeNull();
  });

  it("补录（backfill: true）仍不记组间歇，行为不变（验收 7）", async () => {
    const res = await postSet({
      exercise_id: exerciseId,
      set_no: 4,
      weight_kg: 20,
      reps: 8,
      started_at: "2026-10-15T09:10:00.000Z",
      done_at: "2026-10-15T09:12:00.000Z",
      backfill: true,
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.restBeforeSec).toBeNull();
    expect(body.sameExercise).toBe(false);
  });

  it("幂等重放（同一个确定性键）→ 覆盖同一行，started_at 一起按后一次落定", async () => {
    const key = "started-session-1:replay:d:5";
    const body = {
      client_key: key,
      exercise_id: exerciseId,
      set_no: 5,
      weight_kg: 22.5,
      reps: 8,
      started_at: "2026-10-15T09:20:00.000Z",
      done_at: "2026-10-15T09:20:40.000Z",
    };
    const first = await postSet(body);
    expect(first.status).toBe(201);
    const second = await postSet({ ...body, reps: 7 });
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).created).toBe(false);
    const row = await rowOf(5);
    expect(row?.startedAt).toBe("2026-10-15T09:20:00.000Z");
    // 上一组完成 09:12:00 → 本组 09:20:00 开始 = 480s（重放后仍是同一行、同一值）
    expect(row?.restBeforeSec).toBe(480);
  });

  it("started_at 不是合法时间戳 → 400（不静默吞成 null）", async () => {
    const res = await postSet({
      exercise_id: exerciseId,
      set_no: 6,
      reps: 8,
      started_at: "昨天下午",
      done_at: "2026-10-15T09:30:00.000Z",
    });
    expect(res.status).toBe(400);
    expect(String((await jsonOf(res)).error)).toContain("started_at");
    expect(await rowOf(6)).toBeUndefined();
  });
});
