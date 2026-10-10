/**
 * FR-10 的 doing 阶段（训练中改本次清单）的接口级测试：
 * 加动作 / 移出 / 换动作 / 调顺序（含「先做这个」）/ 调本次目标组数次数。
 *
 * 三条安全约束（交互设计说明 §4.9）都要有用例钉住：
 * 1. 目标组数不能低于已记组数；2. 移出 / 换掉已记组的动作要先确认（409）且确认后连组一起删；
 * 3. 至少留一个动作。另外：只影响本次会话（模板不动），结束的会话不能再改。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-session-edit-"));
process.env.DATABASE_FILE = join(dir, "session-edit.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const routes = {
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { GET: Handler; PATCH: Handler },
  exercises: async () =>
    (await import("@/app/api/v1/sessions/[id]/exercises/route")) as { POST: Handler; PATCH: Handler; DELETE: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  schemes: async () => (await import("@/app/api/v1/schemes/route")) as { GET: Handler },
};

async function library() {
  const { GET } = await import("@/app/api/v1/exercises/route");
  const res = await GET(req("GET", "/api/v1/exercises") as never);
  const body = await jsonOf<{ exercises: { id: number; name: string }[] }>(res);
  return body.exercises;
}

interface DetailPayload {
  exercises: { id: number; exerciseId: number; name: string; orderNo: number; targetSets: number; targetReps: number }[];
  sets: { id: number; exerciseId: number }[];
  summary: { totalSets: number };
}

let sessionId = 0;
let exerciseA = 0;
let exerciseB = 0;
let exerciseC = 0;

async function detail(): Promise<DetailPayload> {
  const { GET } = await routes.session();
  return jsonOf<DetailPayload>(await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })));
}

async function recordSet(exerciseId: number, setNo: number) {
  const { POST } = await routes.sets();
  const res = await POST(
    req("POST", `/api/v1/sessions/${sessionId}/sets`, {
      client_key: `edit-${exerciseId}-${setNo}-${Math.random().toString(36).slice(2, 6)}`,
      exercise_id: exerciseId,
      set_no: setNo,
      weight_kg: 20,
      reps: 10,
    }),
    params({ id: String(sessionId) }),
  );
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  const exercises = await library();
  exerciseA = exercises.find((e) => e.name === "引体向上")!.id;
  exerciseB = exercises.find((e) => e.name === "哑铃弯举")!.id;
  exerciseC = exercises.find((e) => e.name === "平板撑")!.id;

  const { POST } = await routes.sessions();
  const created = await POST(
    req("POST", "/api/v1/sessions", {
      client_id: `edit-session-${Date.now()}`,
      part: "背+二头",
      mode: "gym",
      status: "doing",
      started_at: new Date().toISOString(),
      exercises: [
        { exercise_id: exerciseA, order_no: 0, target_sets: 4, target_reps: 8 },
        { exercise_id: exerciseB, order_no: 1, target_sets: 3, target_reps: 12 },
      ],
    }),
  );
  sessionId = (await jsonOf<{ id: number }>(created)).id;
});

afterAll(async () => {
  try {
    const { getSqlite } = await import("@/db/client");
    getSqlite().close();
  } catch {
    // 没打开过就忽略
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("训练中改本次清单（FR-10 doing 阶段）", () => {
  it("加动作：加在末尾、带上目标组数次数", async () => {
    const { POST } = await routes.exercises();
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises`, { exercise_id: exerciseC, target_sets: 3, target_reps: 60 }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(201);
    const body = await detail();
    expect(body.exercises.map((e) => e.name)).toEqual(["引体向上", "哑铃弯举", "平板撑"]);
    expect(body.exercises[2].targetSets).toBe(3);
    expect(body.exercises[2].targetReps).toBe(60);
    expect(body.exercises[2].orderNo).toBe(2);

    // 非法目标组数 → 400
    const bad = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises`, { exercise_id: exerciseC, target_sets: 0 }),
      params({ id: String(sessionId) }),
    );
    expect(bad.status).toBe(400);
  });

  it("调顺序：up/down 换位、「先做这个」挪到最前", async () => {
    const { PATCH } = await routes.exercises();
    const list = (await detail()).exercises;
    const tableten = list.find((e) => e.name === "平板撑")!;

    // 平板撑往上挪一位 → 排到第 2
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: tableten.id, move: "up" }), params({ id: String(sessionId) }));
    let names = (await detail()).exercises.map((e) => e.name);
    expect(names).toEqual(["引体向上", "平板撑", "哑铃弯举"]);

    // 先做这个 → 挪到最前（页面按"第一个没做满的动作"算当前，所以排到最前就轮到它）
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: tableten.id, move: "first" }), params({ id: String(sessionId) }));
    const after = await detail();
    names = after.exercises.map((e) => e.name);
    expect(names).toEqual(["平板撑", "引体向上", "哑铃弯举"]);
    // orderNo 连续 0..N-1（空号会被展示放大）
    expect(after.exercises.map((e) => e.orderNo)).toEqual([0, 1, 2]);

    // 挪回去，方便后面的用例
    const pullup = after.exercises.find((e) => e.name === "引体向上")!;
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: pullup.id, move: "first" }), params({ id: String(sessionId) }));
    const curl = (await detail()).exercises.find((e) => e.name === "哑铃弯举")!;
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: curl.id, move: "first" }), params({ id: String(sessionId) }));
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: curl.id, move: "down" }), params({ id: String(sessionId) }));
    expect((await detail()).exercises.map((e) => e.name)).toEqual(["引体向上", "哑铃弯举", "平板撑"]);
  });

  it("调本次目标：组数不能低于已记组数（进度自相矛盾）", async () => {
    await recordSet(exerciseA, 1);
    await recordSet(exerciseA, 2);

    const row = (await detail()).exercises.find((e) => e.exerciseId === exerciseA)!;
    const { PATCH } = await routes.exercises();

    // 目标 2 组 = 已记 2 组 → 允许（= 今天不练了）；改成 1 组 → 400
    expect(
      (
        await PATCH(
          req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: row.id, target_sets: 2, target_reps: 8 }),
          params({ id: String(sessionId) }),
        )
      ).status,
    ).toBe(200);
    const bad = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: row.id, target_sets: 1 }),
      params({ id: String(sessionId) }),
    );
    expect(bad.status).toBe(400);
    expect((await jsonOf<{ error: string }>(bad)).error).toContain("已经记了 2 组");

    // 次数照常可改
    await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: row.id, target_sets: 4, target_reps: 10 }), params({ id: String(sessionId) }));
    const updated = (await detail()).exercises.find((e) => e.exerciseId === exerciseA)!;
    expect(updated.targetSets).toBe(4);
    expect(updated.targetReps).toBe(10);
  });

  it("换动作：位置与目标保留；已记组的要先确认（确认后那几组一起删）", async () => {
    const row = (await detail()).exercises.find((e) => e.exerciseId === exerciseA)!;
    const { PATCH } = await routes.exercises();

    // 引体向上记过 2 组 → 不确认换掉 → 409
    const blocked = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: row.id, exercise_id: exerciseC }),
      params({ id: String(sessionId) }),
    );
    expect(blocked.status).toBe(409);
    const blockedBody = await jsonOf<{ needs_confirm: boolean; sets: number }>(blocked);
    expect(blockedBody.needs_confirm).toBe(true);
    expect(blockedBody.sets).toBe(2);
    expect((await detail()).exercises[0].exerciseId).toBe(exerciseA); // 没换成

    // 带 confirm 换掉 → 位置不动、目标保留、那 2 组删掉
    const swapped = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: row.id, exercise_id: exerciseC, confirm: true }),
      params({ id: String(sessionId) }),
    );
    expect(swapped.status).toBe(200);
    expect((await jsonOf<{ deletedSets: number }>(swapped)).deletedSets).toBe(2);
    const after = await detail();
    expect(after.exercises.map((e) => e.name)).toEqual(["平板撑", "哑铃弯举", "平板撑"]);
    expect(after.exercises[0].orderNo).toBe(0);
    expect(after.exercises[0].targetSets).toBe(4); // 目标组数保留
    expect(after.sets.filter((s) => s.exerciseId === exerciseA).length).toBe(0);
  });

  it("移出今天：已记组的要先确认；至少留一个动作", async () => {
    await recordSet(exerciseB, 1);
    const list = (await detail()).exercises;
    const curl = list.find((e) => e.exerciseId === exerciseB)!;
    const { DELETE } = await routes.exercises();

    const blocked = await DELETE(
      req("DELETE", `/api/v1/sessions/${sessionId}/exercises?id=${curl.id}`),
      params({ id: String(sessionId) }),
    );
    expect(blocked.status).toBe(409);
    expect((await jsonOf<{ sets: number }>(blocked)).sets).toBe(1);

    const removed = await DELETE(
      req("DELETE", `/api/v1/sessions/${sessionId}/exercises?id=${curl.id}&confirm=1`),
      params({ id: String(sessionId) }),
    );
    expect(removed.status).toBe(200);
    expect((await jsonOf<{ deletedSets: number }>(removed)).deletedSets).toBe(1);

    const after = await detail();
    expect(after.exercises.some((e) => e.exerciseId === exerciseB)).toBe(false);
    expect(after.exercises.map((e) => e.orderNo)).toEqual([0, 1]); // 重排连续

    // 只剩两个：再删一个可以，删到最后一个 → 400
    const rest = after.exercises;
    const second = await DELETE(
      req("DELETE", `/api/v1/sessions/${sessionId}/exercises?id=${rest[1].id}&confirm=1`),
      params({ id: String(sessionId) }),
    );
    expect(second.status).toBe(200);
    const last = (await detail()).exercises;
    expect(last.length).toBe(1);
    const lastOne = await DELETE(
      req("DELETE", `/api/v1/sessions/${sessionId}/exercises?id=${last[0].id}&confirm=1`),
      params({ id: String(sessionId) }),
    );
    expect(lastOne.status).toBe(400);
  });

  it("只影响本次会话：模板（方案槽位清单）没被改；结束的会话不能再改", async () => {
    // 模板还是种子里的样子（引体向上 + 哑铃弯举 + …），没有被这次编辑动过
    const { GET } = await routes.schemes();
    const schemes = await jsonOf<{ schemes: { id: string; active: boolean; slots: { gym: { name: string }[] }[] }[] }>(
      await GET(req("GET", "/api/v1/schemes")),
    );
    const active = schemes.schemes.find((s) => s.active)!;
    const flat = active.slots.flatMap((s) => s.gym.map((e) => e.name));
    expect(flat).toContain("引体向上");

    // 结束会话 → 补一个动作**放行**（FR-13 v1.18 补明细），改 / 删清单仍然拒绝
    const { PATCH: patchSession, GET: getSession } = await routes.session();
    const done = await patchSession(
      req("PATCH", `/api/v1/sessions/${sessionId}`, { status: "done", ended_at: new Date().toISOString() }),
      params({ id: String(sessionId) }),
    );
    expect(done.status).toBe(200);

    const { POST, PATCH } = await routes.exercises();
    const afterDone = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises`, { exercise_id: exerciseA }),
      params({ id: String(sessionId) }),
    );
    expect(afterDone.status).toBe(201);

    const detail = await jsonOf<{ exercises: { id: number }[] }>(
      await getSession(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const blocked = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}/exercises`, { id: detail.exercises[0].id, target_sets: 5 }),
      params({ id: String(sessionId) }),
    );
    expect(blocked.status).toBe(400);
    expect((await jsonOf<{ error: string }>(blocked)).error).toContain("清单不能再改");
  });
});
