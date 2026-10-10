/**
 * 有氧记录（FR-50 / FR-51，v1.16）的接口级测试。
 *
 * 重点钉住两件事：
 * 1. 一天一条：同一天重复提交 = **覆盖**（幂等），范围校验 1~600 整数、只能今天/昨天；
 * 2. **口径**：有氧是独立的第三类事实 —— 记了有氧**不出勤、不进容量、不参与 streak**（13.4 / 13.6）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-cardio-"));
process.env.DATABASE_FILE = join(dir, "cardio.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

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
  cardio: async () => (await import("@/app/api/v1/cardio/route")) as { GET: Handler; POST: Handler; DELETE: Handler },
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  stats: async () => (await import("@/app/api/v1/stats/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { GET: Handler },
};

let today = "";
let yesterday = "";
let dayBefore = "";

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  yesterday = time.addDays(today, -1);
  dayBefore = time.addDays(today, -2);
  // 首次访问即触发建库 + 种子（迁移里含 cardio_log 表）
  const { GET } = await routes.today();
  expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
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

describe("有氧（FR-50 / FR-51，v1.16）", () => {
  it("记 / 覆盖：同一天重复提交只留一条（幂等）", async () => {
    const { POST, GET } = await routes.cardio();

    const created = await POST(req("POST", "/api/v1/cardio", { date: today, minutes: 30 }));
    expect(created.status).toBe(201);
    expect((await jsonOf<{ created: boolean }>(created)).created).toBe(true);

    const overwritten = await POST(req("POST", "/api/v1/cardio", { date: today, minutes: 40 }));
    expect(overwritten.status).toBe(200);
    expect((await jsonOf<{ created: boolean }>(overwritten)).created).toBe(false);

    const list = await jsonOf<{ rows: { date: string; minutes: number }[]; totalMinutes: number; totalDays: number }>(
      await GET(req("GET", "/api/v1/cardio?days=14")),
    );
    expect(list.rows.filter((r) => r.date === today).length).toBe(1);
    expect(list.rows.find((r) => r.date === today)!.minutes).toBe(40);
    expect(list.totalMinutes).toBe(40);
    expect(list.totalDays).toBe(1);
  });

  it("范围与日期校验：1~600 的整数、只能今天或昨天", async () => {
    const { POST } = await routes.cardio();
    expect((await POST(req("POST", "/api/v1/cardio", { minutes: 0 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/cardio", { minutes: 601 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/cardio", { minutes: 30.5 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/cardio", {}))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/cardio", { minutes: 30, date: "垃圾" }))).status).toBe(400);

    const time = await import("@/lib/time");
    const future = time.addDays(today, 1);
    const futureRes = await POST(req("POST", "/api/v1/cardio", { date: future, minutes: 30 }));
    expect(futureRes.status).toBe(400);
    expect((await jsonOf<{ error: string }>(futureRes)).error).toContain("未来");

    const tooOld = await POST(req("POST", "/api/v1/cardio", { date: dayBefore, minutes: 30 }));
    expect(tooOld.status).toBe(400);
    expect((await jsonOf<{ error: string }>(tooOld)).error).toContain("今天或昨天");

    // 昨天可以补记（13.3 的按天归属）
    const yesterdayRes = await POST(req("POST", "/api/v1/cardio", { date: yesterday, minutes: 20 }));
    expect(yesterdayRes.status).toBe(201);
  });

  it("今日页与记录页都能看到：today.cardio + 记录页单独一行", async () => {
    const { GET: getToday } = await routes.today();
    const todayBody = await jsonOf<{ cardio: { today: { minutes: number } | null; weekMinutes: number; weekDays: number } }>(
      await getToday(req("GET", "/api/v1/today")),
    );
    expect(todayBody.cardio.today?.minutes).toBe(40);
    expect(todayBody.cardio.weekDays).toBe(2); // 今天 + 昨天
    expect(todayBody.cardio.weekMinutes).toBe(60);

    const { GET: getHistory } = await routes.sessions();
    const history = await jsonOf<{ rows: { kind: string; date: string; cardioMinutes: number | null }[] }>(
      await getHistory(req("GET", "/api/v1/sessions?limit=20")),
    );
    const cardioRows = history.rows.filter((r) => r.kind === "cardio");
    expect(cardioRows.length).toBe(2);
    expect(cardioRows.find((r) => r.date === today)!.cardioMinutes).toBe(40);
  });

  it("口径：有氧不出勤、不进容量、不参与 streak（13.4 / 13.6）", async () => {
    const { GET: getToday } = await routes.today();
    const before = await jsonOf<{ streak: number }>(await getToday(req("GET", "/api/v1/today")));

    const { GET: getStats } = await routes.stats();
    const statsBefore = await jsonOf<{ attendedDays: number; volumeKg: number; totalSets: number }>(
      await getStats(req("GET", "/api/v1/stats?days=30")),
    );

    // 只有有氧（今天与昨天各一条），没有训练、没有打卡、没有体重
    expect(statsBefore.attendedDays).toBe(0);
    expect(statsBefore.totalSets).toBe(0);
    expect(statsBefore.volumeKg).toBe(0);

    // 记完有氧后这些口径一个都不变；streak 也不因为"记了有氧"而保住
    const after = await jsonOf<{ streak: number }>(await getToday(req("GET", "/api/v1/today")));
    const statsAfter = await jsonOf<{ attendedDays: number; volumeKg: number; totalSets: number }>(
      await getStats(req("GET", "/api/v1/stats?days=30")),
    );
    expect(after.streak).toBe(before.streak);
    expect(statsAfter).toEqual(statsBefore);
  });

  it("删除：删掉那天的记录，列表里就没有了", async () => {
    const { DELETE, GET } = await routes.cardio();
    const removed = await DELETE(req("DELETE", `/api/v1/cardio?date=${today}`));
    expect(removed.status).toBe(200);
    expect((await jsonOf<{ removed: boolean }>(removed)).removed).toBe(true);

    const again = await DELETE(req("DELETE", `/api/v1/cardio?date=${today}`));
    expect((await jsonOf<{ removed: boolean }>(again)).removed).toBe(false); // 重复删 = no-op

    const list = await jsonOf<{ rows: { date: string }[] }>(await GET(req("GET", "/api/v1/cardio?days=14")));
    expect(list.rows.some((r) => r.date === today)).toBe(false);

    expect((await DELETE(req("DELETE", "/api/v1/cardio"))).status).toBe(400); // 缺 date
  });
});
