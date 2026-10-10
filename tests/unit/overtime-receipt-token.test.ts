/**
 * 审计补缺的接口级用例（2026-09-30）：三件事都「接口/口径有、落地缺一半」，这里把每一半钉死。
 *
 * 1. FR-22「改时间不用删了重录」：`PATCH /api/v1/overtime` 改日期 / 开始时间 / 备注 ——
 *    接口早就实现了，但界面上此前只有「录」和「删」（本轮补了面板与行内「改」）；
 * 2. FR-45 跨零点回执（13.3）：会话按 `started_at` 归属，23:40 开练那场归**前一天**，
 *    所以次日早晨必须**跨自然日**去找最近一场已收工的会话（此前只查当天的会话，恰好查不到）；
 * 3. 助手接口 token（需求书第 7 章：单用户 token，**设置页可重置**）：生成 → 用它认证 →
 *    再生成（旧的立刻失效）→ 清除；库里只存 argon2 哈希，明文只在生成那一次返回。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-audit-"));
process.env.DATABASE_FILE = join(dir, "audit.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { PATCH: Handler },
  overtime: async () => (await import("@/app/api/v1/overtime/route")) as {
    GET: Handler;
    POST: Handler;
    PATCH: Handler;
    DELETE: Handler;
  },
  apiToken: async () => (await import("@/app/api/v1/settings/api-token/route")) as {
    GET: Handler;
    POST: Handler;
    DELETE: Handler;
  },
};

function req(method: string, path: string, body?: unknown, token = "test-token") {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

async function jsonOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeAll(async () => {
  // 首次访问即触发建库 + 种子（与其它接口级用例同一套路）
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

describe("FR-22 加班：改日期 / 开始时间 / 备注（改完判定立刻重算）", () => {
  it("PATCH 改开始时间与备注 → 列表读到新值、判定从「赶不上」翻成「来得及」", async () => {
    const { POST, PATCH, GET } = await routes.overtime();

    const created = await jsonOf<{ id: number; verdict: string }>(
      await POST(req("POST", "/api/v1/overtime", { date: "2026-09-30", start: "20:00" })),
    );
    expect(created.verdict).toBe("late"); // 20:00 < 22:30 → 赶不上

    const patched = await jsonOf<{ start: string; note: string | null; verdict: string }>(
      await PATCH(req("PATCH", "/api/v1/overtime", { id: created.id, start: "23:00", note: "版本上线" })),
    );
    expect(patched.start).toBe("23:00");
    expect(patched.note).toBe("版本上线");
    expect(patched.verdict).toBe("ok"); // 判定读的就是这张表，没有缓存

    const list = await jsonOf<{ overtimes: { id: number; date: string; startTime: string; note: string | null }[] }>(
      await GET(req("GET", "/api/v1/overtime?limit=30")),
    );
    expect(list.overtimes.find((o) => o.id === created.id)).toMatchObject({
      date: "2026-09-30",
      startTime: "23:00",
      note: "版本上线",
    });
  });

  it("日期也能改（补录录错了那天）；备注传 null = 清空；非法时间 400、不存在的 id 404", async () => {
    const { POST, PATCH } = await routes.overtime();

    const created = await jsonOf<{ id: number }>(
      await POST(req("POST", "/api/v1/overtime", { date: "2026-09-30", start: "21:00", note: "临时" })),
    );
    const moved = await jsonOf<{ date: string; note: string | null }>(
      await PATCH(req("PATCH", "/api/v1/overtime", { id: created.id, date: "2026-09-29", note: null })),
    );
    expect(moved.date).toBe("2026-09-29");
    expect(moved.note).toBeNull();

    expect((await PATCH(req("PATCH", "/api/v1/overtime", { id: created.id, start: "25:00" }))).status).toBe(400);
    expect((await PATCH(req("PATCH", "/api/v1/overtime", { id: 999_999, start: "23:00" }))).status).toBe(404);
  });
});

describe("FR-45 跨零点回执（13.3）：次日早晨也看得到「昨晚已练完」", () => {
  // 用例按顺序执行：后一个复用前一个造的会话（与 api.test.ts 的 sessionId 同样套路）
  let midnightSessionId = 0;

  it("造一场 23:40 → 00:20 的会话：date 归属前一天（13.3）", async () => {
    const { POST } = await routes.sessions();
    const created = await jsonOf<{ id: number }>(
      await POST(
        req("POST", "/api/v1/sessions", {
          client_id: "receipt-midnight-1",
          part: "背+二头",
          mode: "gym",
          status: "doing",
          started_at: "2026-09-29T15:40:00.000Z", // +08:00 = 09-29 23:40
        }),
      ),
    );
    midnightSessionId = created.id;

    const { PATCH } = await routes.session();
    const done = await PATCH(
      req("PATCH", `/api/v1/sessions/${midnightSessionId}`, {
        status: "done",
        ended_at: "2026-09-29T16:20:00.000Z", // +08:00 = 09-30 00:20
      }),
      params({ id: String(midnightSessionId) }),
    );
    expect(done.status).toBe(200);

    const { getDb } = await import("@/db/client");
    const { workoutSession } = await import("@/db/schema");
    const row = getDb()
      .select()
      .from(workoutSession)
      .all()
      .find((s) => s.id === midnightSessionId);
    expect(row?.date).toBe("2026-09-29");
  });

  it("次日 00:30 打开首页：回执指向那场（date = 昨天）—— 当天没有会话，页面因此说「昨晚已练完」", async () => {
    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");

    const payload = buildToday(getDb(), "gym", new Date("2026-09-29T16:30:00.000Z")); // 09-30 00:30 +08
    expect(payload.date).toBe("2026-09-30");
    expect(payload.receipt).not.toBeNull();
    expect(payload.receipt?.date).toBe("2026-09-29");
    expect(payload.receipt?.time).toBe("00:20");
    expect(payload.receipt?.hoursSince).toBe(0);
    // 那场归前一天，所以今天这一格是空的 —— 首页据此不显示「今天该练 X」
    expect(payload.session).toBeNull();
  });

  it("超过 6 小时就不出回执了（同日 07:30 打开为空）", async () => {
    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");

    expect(buildToday(getDb(), "gym", new Date("2026-09-29T23:30:00.000Z")).receipt).toBeNull(); // 09-30 07:30 +08
  });

  it("当天练完那场照旧出回执（回归：别把同一天的情况漏掉）", async () => {
    const { POST } = await routes.sessions();
    const created = await jsonOf<{ id: number }>(
      await POST(
        req("POST", "/api/v1/sessions", {
          client_id: "receipt-sameday-1",
          part: "胸+三头",
          mode: "gym",
          status: "doing",
          started_at: "2026-09-30T10:00:00.000Z", // +08:00 = 09-30 18:00
        }),
      ),
    );
    const { PATCH } = await routes.session();
    await PATCH(
      req("PATCH", `/api/v1/sessions/${created.id}`, {
        status: "done",
        ended_at: "2026-09-30T11:00:00.000Z", // +08:00 = 09-30 19:00
      }),
      params({ id: String(created.id) }),
    );

    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");
    const payload = buildToday(getDb(), "gym", new Date("2026-09-30T11:10:00.000Z")); // 09-30 19:10 +08

    expect(payload.receipt?.date).toBe("2026-09-30");
    expect(payload.receipt?.time).toBe("19:00");
    expect(payload.receipt?.hoursSince).toBe(0);
    expect(payload.session?.status).toBe("done");
  });
});

describe("助手接口 token（需求书第 7 章：设置页可重置）", () => {
  const bearer = async (token: string) => {
    const { GET } = await routes.today();
    return GET(new Request(`${BASE}/api/v1/today`, { headers: { authorization: `Bearer ${token}` } }));
  };

  it("生成 → 立刻能用 → 再生成时旧的失效 → 清除后回到 401；环境变量那条路不受影响", async () => {
    const { GET, POST, DELETE } = await routes.apiToken();

    const before = await jsonOf<{ envConfigured: boolean; dbConfigured: boolean }>(
      await GET(req("GET", "/api/v1/settings/api-token")),
    );
    expect(before.envConfigured).toBe(true); // 测试环境配了 API_TOKEN=test-token
    expect(before.dbConfigured).toBe(false); // 库里还没有

    const first = await jsonOf<{ token: string; dbConfigured: boolean }>(
      await POST(req("POST", "/api/v1/settings/api-token")),
    );
    expect(first.dbConfigured).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{20,}$/); // 24 字节随机 → base64url
    expect(first.token).not.toBe("test-token");
    // 明文只在这一次响应里出现：库里存的是 argon2 哈希，再 GET 也拿不回来
    expect((await jsonOf(await GET(req("GET", "/api/v1/settings/api-token")))).dbConfigured).toBe(true);
    expect((await bearer(first.token)).status).toBe(200);

    const second = await jsonOf<{ token: string }>(await POST(req("POST", "/api/v1/settings/api-token")));
    expect(second.token).not.toBe(first.token);
    expect((await bearer(first.token)).status).toBe(401);
    expect((await bearer(second.token)).status).toBe(200);

    const cleared = await jsonOf<{ envConfigured: boolean; dbConfigured: boolean }>(
      await DELETE(req("DELETE", "/api/v1/settings/api-token")),
    );
    expect(cleared.dbConfigured).toBe(false);
    expect(cleared.envConfigured).toBe(true);
    expect((await bearer(second.token)).status).toBe(401);
    expect((await bearer("test-token")).status).toBe(200);
  });

  it("未认证一律 401：不能匿名换 token", async () => {
    const { GET, POST } = await routes.apiToken();
    expect((await GET(new Request(`${BASE}/api/v1/settings/api-token`))).status).toBe(401);
    expect((await POST(new Request(`${BASE}/api/v1/settings/api-token`, { method: "POST" }))).status).toBe(401);
  });
});
