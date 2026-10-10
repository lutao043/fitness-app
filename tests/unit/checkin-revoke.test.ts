/**
 * v1.33（issue #15）：**系统派生物要有撤销路径** —— 会话置 `aborted` 时，把它派生的
 * ①自动打卡（`checkin(kind=workout)`，`ref_id = 会话 id`）与 ②加练循环位点一起撤掉；
 * 一条 `done` 会话按「置 aborted → 删除」走完后，**出勤 / 容量 / 组数 / 打卡**全部回到写入前。
 *
 * 边界（按 issue #15 的验收 3）：
 * - 当天还有另一场 `done` 会话时，那天的打卡不会被撤空（每场各写自己 `ref_id` 的那条）；
 * - **用户手点的「一键打卡」**（`ref_id` 为空）不受影响 —— 撤销只认 `ref_id = 会话 id` 的那条。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-checkin-revoke-"));
process.env.DATABASE_FILE = join(dir, "checkin-revoke.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { GET: Handler; PATCH: Handler; DELETE: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  checkin: async () => (await import("@/app/api/v1/checkin/route")) as { POST: Handler },
  stats: async () => (await import("@/app/api/v1/stats/route")) as { GET: Handler },
};

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
async function jsonOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

let today = "";
let benchId = 0;

async function newSession(clientId: string): Promise<number> {
  const { POST } = await routes.sessions();
  const res = await POST(
    req("POST", "/api/v1/sessions", {
      client_id: clientId,
      date: today,
      part: "胸+三头",
      mode: "gym",
      status: "doing",
      started_at: `${today}T10:00:00+08:00`,
      exercises: [{ exercise_id: benchId, target_sets: 2, target_reps: 12 }],
    }),
  );
  expect(res.status).toBe(201);
  return (await jsonOf<{ id: number }>(res)).id;
}

async function addSet(sessionId: number, key: string) {
  const { POST } = await routes.sets();
  const res = await POST(
    req("POST", `/api/v1/sessions/${sessionId}/sets`, {
      client_key: key,
      exercise_id: benchId,
      set_no: 1,
      weight_kg: 20,
      reps: 12,
      done_at: `${today}T10:05:00+08:00`,
    }),
    params({ id: String(sessionId) }),
  );
  expect(res.status).toBe(201);
}

async function patchStatus(sessionId: number, status: string) {
  const { PATCH } = await routes.session();
  return PATCH(req("PATCH", `/api/v1/sessions/${sessionId}`, { status }), params({ id: String(sessionId) }));
}

async function deleteSession(sessionId: number) {
  const { DELETE } = await routes.session();
  return DELETE(req("DELETE", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) }));
}

async function workoutCheckins(): Promise<{ id: number; date: string; refId: string }[]> {
  const { getSqlite } = await import("@/db/client");
  return getSqlite()
    .prepare("select id, date, ref_id as refId from checkin where kind = 'workout' order by id")
    .all() as { id: number; date: string; refId: string }[];
}

async function setCount(sessionId: number): Promise<number> {
  const { getSqlite } = await import("@/db/client");
  return (getSqlite().prepare("select count(*) as c from set_log where session_id = ?").get(sessionId) as { c: number }).c;
}

async function attendedDays(): Promise<number> {
  const { GET } = await routes.stats();
  const body = await jsonOf<{ attendedDays: number }>(await GET(req("GET", "/api/v1/stats?days=30")));
  return body.attendedDays;
}

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  const { GET } = await routes.today();
  expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
  const { getDb } = await import("@/db/client");
  const { exercise } = await import("@/db/schema");
  benchId = getDb().select().from(exercise).all().find((e) => e.name === "平板卧推")!.id;
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

describe("会话派生物：置 aborted 时撤自动打卡（issue #15）", () => {
  it("done → aborted → 删除：出勤 / 容量 / 组数 / 打卡全部回到写入前", async () => {
    const attendanceBefore = await attendedDays();
    const checkinsBefore = (await workoutCheckins()).length;

    const sessionId = await newSession("rev-a");
    await addSet(sessionId, "rev-a-s1");
    const done = await patchStatus(sessionId, "done");
    expect(done.status).toBe(200);
    // 收工 → 自动写一条打卡，且**带 ref_id = 会话 id**（撤销靠它精确匹配）
    const afterDone = await workoutCheckins();
    expect(afterDone.length).toBe(checkinsBefore + 1);
    expect(afterDone.at(-1)?.refId).toBe(String(sessionId));
    expect(await attendedDays()).toBeGreaterThanOrEqual(attendanceBefore + 1 - 1); // 今天本来就可能有出勤

    // 置 aborted → 派生的打卡被撤（组明细还在：aborted 只是"不算练完"）
    expect((await patchStatus(sessionId, "aborted")).status).toBe(200);
    const afterAbort = await workoutCheckins();
    expect(afterAbort.length).toBe(checkinsBefore);
    expect(afterAbort.some((c) => c.refId === String(sessionId))).toBe(false);

    // 再删会话 → 组明细没了（issue #15 那条脏会话的真实路径）
    expect((await deleteSession(sessionId)).status).toBe(200);
    expect(await setCount(sessionId)).toBe(0);
    expect((await workoutCheckins()).length).toBe(checkinsBefore);
    expect(await attendedDays()).toBe(attendanceBefore);
  });

  it("边界：当天还有另一场 done 会话 → 撤掉的那场不影响那天的打卡", async () => {
    const a = await newSession("rev-b1");
    const b = await newSession("rev-b2");
    expect((await patchStatus(a, "done")).status).toBe(200);
    expect((await patchStatus(b, "done")).status).toBe(200);
    const both = await workoutCheckins();
    // 每场各写自己 ref_id 的那条（同一天两条并存，13.4 的出勤按天去重）
    expect(both.some((c) => c.refId === String(a))).toBe(true);
    expect(both.some((c) => c.refId === String(b))).toBe(true);
    const attendance = await attendedDays();

    // 撤掉 A：B 的打卡还在 → 那天的出勤不变
    expect((await patchStatus(a, "aborted")).status).toBe(200);
    const left = await workoutCheckins();
    expect(left.some((c) => c.refId === String(a))).toBe(false);
    expect(left.some((c) => c.refId === String(b))).toBe(true);
    expect(await attendedDays()).toBe(attendance);

    // 收尾：把 B 也撤掉，别给后面的用例留出勤
    expect((await patchStatus(b, "aborted")).status).toBe(200);
    await deleteSession(a);
    await deleteSession(b);
  });

  it("用户手点的「一键打卡」（ref_id 为空）不受会话撤销影响", async () => {
    const { POST: checkinPost } = await routes.checkin();
    const manual = await checkinPost(req("POST", "/api/v1/checkin", { date: today, kind: "workout" }));
    expect([200, 201]).toContain(manual.status);

    const sessionId = await newSession("rev-c");
    expect((await patchStatus(sessionId, "done")).status).toBe(200);
    expect((await patchStatus(sessionId, "aborted")).status).toBe(200);

    const rows = await workoutCheckins();
    // 会话那条被撤了，手点的那条（ref_id = ""）还在
    expect(rows.some((c) => c.refId === String(sessionId))).toBe(false);
    expect(rows.some((c) => c.refId === "")).toBe(true);

    // 收尾：删掉那场会话；手工打卡留着（它是用户的事实，不该被系统擦掉）
    await deleteSession(sessionId);
  });

  it("重复置 aborted = 幂等（不报错、打卡也不会被误删第二次）", async () => {
    const sessionId = await newSession("rev-d");
    expect((await patchStatus(sessionId, "done")).status).toBe(200);
    expect((await patchStatus(sessionId, "aborted")).status).toBe(200);
    expect((await patchStatus(sessionId, "aborted")).status).toBe(200);
    expect((await workoutCheckins()).some((c) => c.refId === String(sessionId))).toBe(false);
    await deleteSession(sessionId);
  });
});
