/**
 * 记录页「换动作」：把某动作本次已记的组整体搬到另一个动作（issue #43 / v1.46）。
 *
 * 这条接口存在的意义就是**不许按"补录"处理**：删了重补会把 `rest_before_sec / same_exercise` 变成 null，
 * 组间歇均值与「换项间隔」统计跟着失真。这里把它钉死。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-move-sets-"));
process.env.DATABASE_FILE = join(dir, "move.sqlite");
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

describe("换动作（搬组不丢组间歇）", () => {
  let sessionId = 0;
  let fromId = 0; // 器械读数：读数即总重
  let sameModeId = 0; // 同为器械：容量应保持不变
  let otherModeId = 0; // 哑铃：总重 = 单侧 × 2

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq, ne } = await import("drizzle-orm");
    const db = getDb();

    const machineEx = db
      .select()
      .from(schema.exercise)
      .where(eq(schema.exercise.loadMode, "machine"))
      .limit(2)
      .all();
    const dumbbellEx = db
      .select()
      .from(schema.exercise)
      .where(eq(schema.exercise.loadMode, "dumbbell"))
      .limit(1)
      .get();
    expect(machineEx.length).toBeGreaterThan(1);
    expect(dumbbellEx).toBeTruthy();
    fromId = machineEx[0].id;
    sameModeId = machineEx[1].id;
    otherModeId = dumbbellEx!.id;

    const { POST: sessPOST } = await import("@/app/api/v1/sessions/route");
    const created = await jsonOf(
      await sessPOST(
        req("POST", "/api/v1/sessions", {
          client_id: "move-sets-session",
          part: "背+二头",
          mode: "gym",
          status: "doing",
          started_at: "2026-10-09T09:00:00.000Z",
        }),
      ),
    );
    sessionId = Number(created.id);

    const { POST: addEx } = await import("@/app/api/v1/sessions/[id]/exercises/route");
    await addEx(
      req("POST", `/api/v1/sessions/${sessionId}/exercises`, {
        exercise_id: fromId,
        target_sets: 4,
        target_reps: 12,
      }),
      params({ id: String(sessionId) }),
    );

    // 记 4 组，组间歇像真人（264 / 79 / 245 / 254 秒）
    const { POST: setPOST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const doneAt = [
      "2026-10-09T09:04:24.000Z",
      "2026-10-09T09:08:07.000Z",
      "2026-10-09T09:12:32.000Z",
      "2026-10-09T09:16:46.000Z",
    ];
    for (let i = 0; i < 4; i++) {
      const res = await setPOST(
        req("POST", `/api/v1/sessions/${sessionId}/sets`, {
          client_key: `move-set-${i + 1}`,
          exercise_id: fromId,
          set_no: i + 1,
          weight_kg: 20,
          reps: 12,
          done_at: doneAt[i],
        }),
        params({ id: String(sessionId) }),
      );
      expect(res.status).toBe(201);
    }
    // 收工（已收工也要能换 —— 事后发现记错动作是合法修正）
    const { PATCH } = await import("@/app/api/v1/sessions/[id]/route");
    const done = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}`, {
        status: "done",
        ended_at: "2026-10-09T09:40:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(done.status).toBe(200);
    void ne;
  });

  async function detail() {
    const { GET } = await import("@/app/api/v1/sessions/[id]/route");
    return jsonOf(await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })));
  }

  it("已收工会话把 4 组换到同 loadMode 的动作：组间歇逐条不变、统计不变、不留僵尸行", async () => {
    const before = await detail();
    const beforeSummary = before.summary as { totalSets: number; volumeKg: number; avgRestSec: number; sameRestSets: number };
    const beforeRests = (before.sets as { restBeforeSec: number | null; sameExercise: boolean }[])
      .filter((s) => s.restBeforeSec !== null)
      .map((s) => s.restBeforeSec);

    const { POST: movePOST } = await import("@/app/api/v1/sessions/[id]/exercises/move/route");
    const res = await movePOST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises/move`, {
        from_exercise_id: fromId,
        to_exercise_id: sameModeId,
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.changed).toBe(true);
    expect(body.movedSets).toBe(4);
    expect(body.volumeBeforeKg).toBe(body.volumeAfterKg); // 同为器械：读数即总重

    const after = await detail();
    const afterSummary = after.summary as typeof beforeSummary;
    expect(afterSummary.totalSets).toBe(beforeSummary.totalSets);
    expect(afterSummary.volumeKg).toBe(beforeSummary.volumeKg);
    expect(afterSummary.avgRestSec).toBe(beforeSummary.avgRestSec); // ← 这条是核心
    expect(afterSummary.sameRestSets).toBe(beforeSummary.sameRestSets);
    const afterRests = (after.sets as { exerciseId: number; restBeforeSec: number | null; sameExercise: boolean }[])
      .filter((s) => s.exerciseId === sameModeId && s.restBeforeSec !== null)
      .map((s) => s.restBeforeSec);
    expect(afterRests).toEqual(beforeRests);
    expect(afterRests).toHaveLength(3); // 第一组没有组间歇（13.5）

    // 旧动作不再出现（组与清单行都不留）
    expect((after.sets as { exerciseId: number }[]).some((s) => s.exerciseId === fromId)).toBe(false);
    const exRows = after.exercises as { exerciseId: number }[];
    expect(exRows.some((e) => e.exerciseId === fromId)).toBe(false);
    expect(exRows.filter((e) => e.exerciseId === sameModeId)).toHaveLength(1); // 不重复、无僵尸
  });

  it("换到不同 loadMode 的动作：容量按新口径重算（哑铃 = 单侧 × 2）", async () => {
    const { POST: movePOST } = await import("@/app/api/v1/sessions/[id]/exercises/move/route");
    const res = await movePOST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises/move`, {
        from_exercise_id: sameModeId,
        to_exercise_id: otherModeId,
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res) as { volumeBeforeKg: number; volumeAfterKg: number };
    expect(body.volumeAfterKg).toBe(body.volumeBeforeKg * 2); // 20 kg 单侧 → 哑铃总重 40

    const after = await detail();
    const summary = after.summary as { volumeKg: number };
    expect(summary.volumeKg).toBe(body.volumeAfterKg);
    // 组间歇仍然带过来（口径：不重算、不清空）
    const rests = (after.sets as { restBeforeSec: number | null }[]).filter((s) => s.restBeforeSec !== null);
    expect(rests.length).toBeGreaterThan(0);
  });

  it("换成自己 → changed:false，无副作用", async () => {
    const before = await detail();
    const { POST: movePOST } = await import("@/app/api/v1/sessions/[id]/exercises/move/route");
    const res = await movePOST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises/move`, {
        from_exercise_id: otherModeId,
        to_exercise_id: otherModeId,
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).changed).toBe(false);
    const after = await detail();
    expect((after.summary as { volumeKg: number }).volumeKg).toBe((before.summary as { volumeKg: number }).volumeKg);
  });

  it("aborted 会话 → 400（与现有门禁一致）", async () => {
    const { POST: sessPOST } = await import("@/app/api/v1/sessions/route");
    const created = await jsonOf(
      await sessPOST(
        req("POST", "/api/v1/sessions", {
          client_id: "move-sets-aborted",
          part: "腿",
          mode: "gym",
          status: "doing",
          started_at: "2026-10-09T10:00:00.000Z",
        }),
      ),
    );
    const id = Number(created.id);
    const { PATCH } = await import("@/app/api/v1/sessions/[id]/route");
    await PATCH(req("PATCH", `/api/v1/sessions/${id}`, { status: "aborted" }), params({ id: String(id) }));

    const { POST: movePOST } = await import("@/app/api/v1/sessions/[id]/exercises/move/route");
    const res = await movePOST(
      req("POST", `/api/v1/sessions/${id}/exercises/move`, {
        from_exercise_id: fromId,
        to_exercise_id: sameModeId,
      }),
      params({ id: String(id) }),
    );
    expect(res.status).toBe(400);
  });

  it("doing 会话也允许：组不丢、无需 confirm（与删除式换动作的区别）", async () => {
    const { POST: sessPOST } = await import("@/app/api/v1/sessions/route");
    const created = await jsonOf(
      await sessPOST(
        req("POST", "/api/v1/sessions", {
          client_id: "move-sets-doing",
          part: "胸+三头",
          mode: "gym",
          status: "doing",
          started_at: "2026-10-09T11:00:00.000Z",
        }),
      ),
    );
    const id = Number(created.id);
    const { POST: setPOST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    await setPOST(
      req("POST", `/api/v1/sessions/${id}/sets`, {
        client_key: "move-doing-1",
        exercise_id: fromId,
        set_no: 1,
        weight_kg: 25,
        reps: 10,
        done_at: "2026-10-09T11:02:00.000Z",
      }),
      params({ id: String(id) }),
    );

    const { POST: movePOST } = await import("@/app/api/v1/sessions/[id]/exercises/move/route");
    const res = await movePOST(
      req("POST", `/api/v1/sessions/${id}/exercises/move`, {
        from_exercise_id: fromId,
        to_exercise_id: sameModeId,
      }),
      params({ id: String(id) }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).movedSets).toBe(1);
  });
});
