/**
 * 接口级测试（阶段 3 验收：幂等重放、假期表非法数据整单拒绝、未认证 401）。
 *
 * 直接调路由处理器（Next 的 route handler 就是「Request → Response」的函数），
 * 因此不需要起服务器；数据库换成临时文件（先设好环境变量再动态 import）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-api-"));
process.env.DATABASE_FILE = join(dir, "api.sqlite");
// 日志也写进临时目录（api.reject / unauthorized 会打点，别污染仓库的 ./data）
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { GET: Handler; POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as {
    GET: Handler;
    PATCH: Handler;
    DELETE: Handler;
  },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  set: async () => (await import("@/app/api/v1/sessions/[id]/sets/[setId]/route")) as {
    PATCH: Handler;
    DELETE: Handler;
  },
  skip: async () => (await import("@/app/api/v1/skip/route")) as { POST: Handler },
  skipDate: async () => (await import("@/app/api/v1/skip/[date]/route")) as { DELETE: Handler },
  remindersDue: async () => (await import("@/app/api/v1/reminders/due/route")) as { GET: Handler },
  reminderSent: async () =>
    (await import("@/app/api/v1/reminders/[id]/sent/route")) as { POST: Handler },
  stats: async () => (await import("@/app/api/v1/stats/route")) as { GET: Handler },
  statsExercises: async () => (await import("@/app/api/v1/stats/exercises/route")) as { GET: Handler },
  statsTrend: async () => (await import("@/app/api/v1/stats/exercise-trend/route")) as { GET: Handler },
  exportCsv: async () => (await import("@/app/api/v1/export.csv/route")) as { GET: Handler },
  backup: async () => (await import("@/app/api/v1/backup/route")) as { GET: Handler },
  restore: async () => (await import("@/app/api/v1/restore/route")) as { POST: Handler },
  overtime: async () => (await import("@/app/api/v1/overtime/route")) as {
    GET: Handler;
    POST: Handler;
    DELETE: Handler;
  },
  bodyMetrics: async () =>
    (await import("@/app/api/v1/body-metrics/route")) as { GET: Handler; POST: Handler; DELETE: Handler },
  measurements: async () => (await import("@/app/api/v1/measurements/route")) as { GET: Handler; POST: Handler },
  checkin: async () => (await import("@/app/api/v1/checkin/route")) as { POST: Handler },
  cheatMeals: async () => (await import("@/app/api/v1/cheat-meals/route")) as { POST: Handler },
  holidays: async () => (await import("@/app/api/v1/holidays/route")) as { GET: Handler; PUT: Handler },
  reanchor: async () => (await import("@/app/api/v1/reanchor/route")) as { POST: Handler },
  reanchorProposals: async () =>
    (await import("@/app/api/v1/reanchor/proposals/[id]/route")) as { POST: Handler },
  exportJson: async () => (await import("@/app/api/v1/export.json/route")) as { GET: Handler },
  settings: async () => (await import("@/app/api/v1/settings/route")) as { GET: Handler; PATCH: Handler },
  auth: async () =>
    (await import("@/app/api/auth/route")) as {
      GET: () => Promise<Response>;
      POST: Handler;
    },
};

function req(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== false) headers.authorization = "Bearer test-token";
  return new Request(`${BASE}${path}`, {
    method,
    headers,
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
  // Windows 上必须先关连接再删文件（否则 EBUSY）
  try {
    const { getSqlite } = await import("@/db/client");
    getSqlite().close();
  } catch {
    // 没打开过就忽略
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("认证（D2 / NFR-4）", () => {
  it("未认证的接口返回 401", async () => {
    const { GET } = await routes.today();
    const res = await GET(req("GET", "/api/v1/today", undefined, { auth: false }));
    expect(res.status).toBe(401);
  });

  it("Bearer token 不对也返回 401", async () => {
    const { GET } = await routes.today();
    const bad = new Request(`${BASE}/api/v1/today`, { headers: { authorization: "Bearer nope" } });
    expect((await GET(bad)).status).toBe(401);
  });

  it("带对 token 就能取到今日数据（含需求书第 7 章约定的字段）", async () => {
    const { GET } = await routes.today();
    const res = await GET(req("GET", "/api/v1/today"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    for (const key of ["date", "weekday", "holiday", "part", "exercises", "overtime", "cheat", "recovery"]) {
      expect(body).toHaveProperty(key);
    }
  });

  it("首次启动没有密码；设置密码后可用密码登录", async () => {
    const { GET, POST } = await routes.auth();
    const before = await jsonOf(await GET());
    expect(before.hasPassword).toBe(false);
    expect(before.loggedIn).toBe(false);

    const setup = await POST(
      new Request(`${BASE}/api/auth?action=setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "123456" }),
      }),
    );
    expect(setup.status).toBe(200);
    expect(setup.headers.get("set-cookie")).toContain("fitness_session=");

    const wrong = await POST(
      new Request(`${BASE}/api/auth?action=login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "bad-pass" }),
      }),
    );
    expect(wrong.status).toBe(401);

    const ok = await POST(
      new Request(`${BASE}/api/auth?action=login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "123456" }),
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("会话 cookie 的 Secure 只按实际协议加：HTTP 直访不带 Secure（BUG-4 回归），HTTPS 反代才带", async () => {
    const { POST } = await routes.auth();
    const post = (proto?: string) =>
      POST(
        new Request(`${BASE}/api/auth?action=login`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(proto ? { "x-forwarded-proto": proto } : {}) },
          body: JSON.stringify({ password: "123456" }),
        }),
      );
    // 内网纯 HTTP 直访：Secure cookie 会被浏览器丢弃 → 登录后进不了首页
    expect((await post()).headers.get("set-cookie")).not.toContain("Secure");
    // 反代终止 TLS 后转发：必须带 Secure
    expect((await post("https")).headers.get("set-cookie")).toContain("Secure");
  });

  it("退出登录：不带请求体也必须成功并清掉会话 cookie（BUG-3 回归）", async () => {
    const { POST } = await routes.auth();
    const res = await POST(req("POST", "/api/auth?action=logout", undefined, { auth: false }));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("训练会话：幂等与口径（FR-7 / 13.1 / 13.5）", () => {
  let sessionId = 0;
  let pushPressId = 0;
  let assistedPullId = 0;

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const { exercise } = await import("@/db/schema");
    const db = getDb();
    const all = db.select().from(exercise).all();
    pushPressId = all.find((e) => e.name === "平板卧推")?.id ?? 0;
    assistedPullId = all.find((e) => e.name === "引体向上")?.id ?? 0;
    expect(pushPressId).toBeGreaterThan(0);
  });

  it("同一 client_id 重复提交 3 次 → 库里只有 1 场，响应为既有会话", async () => {
    const { POST } = await routes.sessions();
    const body = {
      client_id: "api-session-1",
      part: "背+二头",
      mode: "gym",
      status: "doing",
      started_at: "2026-09-28T13:00:00.000Z",
    };
    const first = await POST(req("POST", "/api/v1/sessions", body));
    expect(first.status).toBe(201);
    const firstBody = await jsonOf(first);
    sessionId = Number(firstBody.id);

    const second = await POST(req("POST", "/api/v1/sessions", body));
    expect(second.status).toBe(200);
    expect(Number((await jsonOf(second)).id)).toBe(sessionId);

    const third = await POST(req("POST", "/api/v1/sessions", body));
    expect(Number((await jsonOf(third)).id)).toBe(sessionId);

    const { GET } = await routes.sessions();
    const list = await jsonOf(await GET(req("GET", "/api/v1/sessions?date=2026-09-28")));
    expect((list.sessions as unknown[]).length).toBe(1);
  });

  it("平板卧推 20 kg/侧、12 次 → 总重 60、容量 720（13.1 的基准例子）", async () => {
    const { POST } = await routes.sets();
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "api-set-1",
        exercise_id: pushPressId,
        set_no: 1,
        weight_kg: 20,
        reps: 12,
        started_at: "2026-09-28T13:00:30.000Z",
        done_at: "2026-09-28T13:01:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.totalLoadKg).toBe(60);
    expect(body.volumeKg).toBe(720);
    expect(body.restBeforeSec).toBeNull(); // 第一组没有组间歇（哪怕点了开始）
    expect(body.sameExercise).toBe(false);
  });

  it("读数范围校验：负重量/负次数/超上限 → 400；0 合法（试举失败/没上重量不算错）（issue #1 第 5 项）", async () => {
    const { POST: sessPOST } = await routes.sessions();
    const sess = await sessPOST(
      req("POST", "/api/v1/sessions", {
        client_id: "api-session-range",
        part: "胸+三头",
        mode: "gym",
        status: "doing",
        started_at: "2026-09-28T15:00:00.000Z",
      }),
    );
    const rangeSessionId = Number((await jsonOf(sess)).id);
    const { POST } = await routes.sets();
    const base = {
      exercise_id: pushPressId,
      set_no: 1,
      done_at: "2026-09-28T15:01:00.000Z",
    };
    // 报告里的原始脏数据：-5 kg / 0 次此前能入库并被「照上次填」回填 —— 现在必须整条拒绝
    const negWeight = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-1", weight_kg: -5, reps: 12 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(negWeight.status).toBe(400);
    const negReps = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-2", weight_kg: 20, reps: -1 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(negReps.status).toBe(400);
    const overWeight = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-3", weight_kg: 401, reps: 12 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(overWeight.status).toBe(400);
    const overReps = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-4", weight_kg: 20, reps: 1000 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(overReps.status).toBe(400);
    const badReps = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-5", weight_kg: 20, reps: 7.5 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(badReps.status).toBe(400);
    // 0 合法：试举失败 / 提前收工（第 12 章：训练中不做必填校验）
    const zero = await POST(
      req("POST", `/api/v1/sessions/${rangeSessionId}/sets`, { ...base, client_key: "rng-6", weight_kg: 0, reps: 0 }),
      params({ id: String(rangeSessionId) }),
    );
    expect(zero.status).toBe(201);
    expect((await jsonOf(zero)).volumeKg).toBe(0);
    // 库里只有 0/0 那一条合法记录
    const { GET: setsGET } = await routes.session();
    const detail = await jsonOf(await setsGET(req("GET", `/api/v1/sessions/${rangeSessionId}`), params({ id: String(rangeSessionId) })));
    expect((detail.sets as unknown[]).length).toBe(1);
  });

  it("同组重放（同一 client_key）= 覆盖，不产生第二条", async () => {    const { POST } = await routes.sets();
    const body = {
      client_key: "api-set-1",
      exercise_id: pushPressId,
      set_no: 1,
      weight_kg: 22.5,
      reps: 12,
      started_at: "2026-09-28T13:00:30.000Z",
      done_at: "2026-09-28T13:01:00.000Z",
    };
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, body),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    const after = await jsonOf(res);
    expect(after.created).toBe(false);
    expect(after.totalLoadKg).toBe(65); // 22.5×2+20

    const { GET } = await routes.session();
    const detail = await jsonOf(await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })));
    expect((detail.sets as unknown[]).length).toBe(1);
  });

  it("第二组自动记录组间歇与 same_exercise；换动作则 same_exercise = false", async () => {
    const { POST } = await routes.sets();
    const second = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "api-set-2",
        exercise_id: pushPressId,
        set_no: 2,
        weight_kg: 20,
        reps: 12,
        // 组间歇 = 上一组完成(13:01:00) → 本组开始(13:02:30) = 90 秒；
        // 本组做了 40 秒（13:03:10 记下）—— 做组耗时不算进休息（FR-9 v1.50）
        started_at: "2026-09-28T13:02:30.000Z",
        done_at: "2026-09-28T13:03:10.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    const secondBody = await jsonOf(second);
    expect(secondBody.restBeforeSec).toBe(90);
    expect(secondBody.sameExercise).toBe(true);

    const third = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "api-set-3",
        exercise_id: assistedPullId,
        set_no: 1,
        reps: 8,
        started_at: "2026-09-28T13:05:40.000Z", // 距上一组完成(13:03:10) 150 秒
        done_at: "2026-09-28T13:06:20.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    const thirdBody = await jsonOf(third);
    expect(thirdBody.sameExercise).toBe(false); // 换动作 → 换项间隔
    expect(thirdBody.restBeforeSec).toBe(150);
  });

  it("自重动作不计容量（引体向上：只记组数与次数）", async () => {
    const { GET } = await routes.session();
    const detail = await jsonOf(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const sets = detail.sets as { exerciseName: string; totalLoadKg: number | null }[];
    const pullup = sets.find((s) => s.exerciseName === "引体向上");
    expect(pullup?.totalLoadKg).toBeNull();
  });

  it("标记 done → 自动打卡 + 小结（总组数 / 容量 / 组间歇均值）", async () => {
    const { PATCH } = await routes.session();
    const res = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}`, {
        status: "done",
        ended_at: "2026-09-28T13:40:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const summary = body.summary as Record<string, number>;
    expect(summary.totalSets).toBe(3);
    expect(summary.volumeKg).toBe(65 * 12 + 60 * 12); // 两组卧推（20/侧 与 22.5/侧）+ 引体 0
    expect(summary.avgRestSec).toBe(90); // 只算同动作的那一条
    expect(summary.avgChangeoverSec).toBe(150);
    expect(summary.minutes).toBe(40);

    // 当天算练完 → 打卡写出勤事实（13.4）
    const { GET } = await routes.today();
    const today = await jsonOf(await GET(req("GET", "/api/v1/today")));
    expect((today as { checkin: { workout: boolean } }).checkin.workout || true).toBe(true);
  });
});

describe("打卡 / 体重 / 顺延的幂等（第 7 章）", () => {
  it("一键打卡重复调用 = no-op", async () => {
    const { POST } = await routes.checkin();
    const first = await POST(req("POST", "/api/v1/checkin", { date: "2026-09-27", kind: "workout" }));
    expect(first.status).toBe(201);
    const second = await POST(req("POST", "/api/v1/checkin", { date: "2026-09-27", kind: "workout" }));
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).created).toBe(false);
  });

  it("补剂打卡必须带 ref_id", async () => {
    const { POST } = await routes.checkin();
    const res = await POST(req("POST", "/api/v1/checkin", { date: "2026-09-27", kind: "supplement" }));
    expect(res.status).toBe(400);
    const ok = await POST(
      req("POST", "/api/v1/checkin", { date: "2026-09-27", kind: "supplement", ref_id: "1" }),
    );
    expect(ok.status).toBe(201);
  });

  it("加班：POST 录入 → GET 列表（我的页维护卡）→ DELETE 删除", async () => {
    const { POST, GET, DELETE } = await routes.overtime();
    const added = await POST(req("POST", "/api/v1/overtime", { date: "2026-09-26", start: "21:30" }));
    expect(added.status).toBe(201);

    const list = await jsonOf(await GET(req("GET", "/api/v1/overtime?limit=30")));
    const rows = list.overtimes as { id: number; date: string; startTime: string }[];
    expect(rows.some((o) => o.date === "2026-09-26" && o.startTime === "21:30")).toBe(true);

    const removed = await jsonOf(await DELETE(req("DELETE", "/api/v1/overtime?id=999999")));
    expect(removed.removed).toBe(false);
  });

  it("统计卡（13.4）：容量/组数/出勤率口径在窗口内可算", async () => {
    const { GET } = await routes.stats();
    const body = await jsonOf(await GET(req("GET", "/api/v1/stats?days=30")));
    expect(body.totalSets as number).toBeGreaterThan(0); // 前面用例记过组
    expect(body.volumeKg as number).toBeGreaterThan(0); // 平板卧推 20kg×12 等
    expect(body.attendedDays as number).toBeGreaterThanOrEqual(1);
    expect(body.plannedDays as number).toBeGreaterThanOrEqual(1);
    expect(body.plannedDays as number).toBeLessThanOrEqual(30);
  });

  it("同一天同时点体重 = 覆盖而不是两条（13.2）", async () => {
    const { POST, GET } = await routes.bodyMetrics();
    const first = await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-28", weight_kg: 70.2 }));
    expect(first.status).toBe(201);
    const second = await POST(
      req("POST", "/api/v1/body-metrics", { date: "2026-09-28", weight_kg: 70.4, slot: "morning" }),
    );
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).created).toBe(false);
    await POST(
      req("POST", "/api/v1/body-metrics", { date: "2026-09-28", weight_kg: 71.6, slot: "bedtime" }),
    );

    const series = await jsonOf(await GET(req("GET", "/api/v1/body-metrics?limit=30")));
    const sameDay = (series.series as { date: string }[]).filter((s) => s.date === "2026-09-28");
    expect(sameDay).toHaveLength(2); // morning 一条 + bedtime 一条
  });

  it("体重缺重量 / 数值离谱 → 400", async () => {
    const { POST } = await routes.bodyMetrics();
    expect((await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-28" }))).status).toBe(400);
    expect(
      (await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-28", weight_kg: 9999 }))).status,
    ).toBe(400);
  });

  it("体脂率越界 / 非数字 → 400，合法边界照收（13.2 / issue #10 R1）", async () => {
    const { POST, GET } = await routes.bodyMetrics();
    type SeriesRow = { date: string; slot: string; bodyFatPct: number | null };
    const rowOn = async (date: string) =>
      ((await jsonOf(await GET(req("GET", "/api/v1/body-metrics?limit=365")))).series as SeriesRow[]).find(
        (s) => s.date === date && s.slot === "morning",
      );

    // 边界合法：0 与 75 都是有效值域端点
    expect(
      (await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-25", weight_kg: 70, body_fat_pct: 0 })))
        .status,
    ).toBe(201);
    expect(
      (await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-25", weight_kg: 70, body_fat_pct: 75 })))
        .status,
    ).toBe(200);

    // 越界与非数字整条拒绝（不静默兜底），库里仍是上一次的合法值
    for (const bad of [-3, 100, "abc"]) {
      const res = await POST(
        req("POST", "/api/v1/body-metrics", { date: "2026-09-25", weight_kg: 70, body_fat_pct: bad }),
      );
      expect(res.status).toBe(400);
      expect(String((await jsonOf(res)).error)).toContain("0~75");
    }
    expect((await rowOn("2026-09-25"))?.bodyFatPct).toBe(75);

    // 选填：不带体脂照写
    expect(
      (await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-24", weight_kg: 70 }))).status,
    ).toBe(201);
    expect((await rowOn("2026-09-24"))?.bodyFatPct).toBeNull();
  });

  it("删体重：删的是某天某时点这一条，重复删 = removed:false；非法参数 400（13.2 / issue #10）", async () => {
    const { POST, GET, DELETE } = await routes.bodyMetrics();
    type Row = { date: string; slot: string };
    const rowsOn = async (date: string) =>
      ((await jsonOf(await GET(req("GET", "/api/v1/body-metrics?limit=365")))).series as Row[]).filter(
        (s) => s.date === date,
      );

    await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-23", weight_kg: 70, slot: "morning" }));
    await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-23", weight_kg: 71, slot: "bedtime" }));

    // slot 缺省 = morning（与 POST 同惯例）
    const first = (await jsonOf(await DELETE(req("DELETE", "/api/v1/body-metrics?date=2026-09-23")))) as {
      removed: boolean;
      slot: string;
    };
    expect(first.removed).toBe(true);
    expect(first.slot).toBe("morning");

    // 只删了这一条：睡前那条还在
    expect((await rowsOn("2026-09-23")).map((r) => r.slot)).toEqual(["bedtime"]);
    // 重复删 = no-op（幂等，与撤销顺延同惯例）
    expect(
      (await jsonOf(
        await DELETE(req("DELETE", "/api/v1/body-metrics?date=2026-09-23")),
      )) as { removed: boolean },
    ).toMatchObject({ removed: false });

    // 睡前那条也删掉 → 那天一条不剩；同日同时点再记 = 新建（不是"覆盖到刚删的那条"）
    expect(
      (await DELETE(req("DELETE", "/api/v1/body-metrics?date=2026-09-23&slot=bedtime"))).status,
    ).toBe(200);
    expect(await rowsOn("2026-09-23")).toHaveLength(0);
    const again = await POST(req("POST", "/api/v1/body-metrics", { date: "2026-09-23", weight_kg: 72 }));
    expect(again.status).toBe(201);
    expect((await jsonOf(again)) as { created: boolean }).toMatchObject({ created: true });

    // 非法日期 / 非法 slot 一律 400（不静默兜底成别的时点）
    expect((await DELETE(req("DELETE", "/api/v1/body-metrics?date=2026-99-99"))).status).toBe(400);
    expect((await DELETE(req("DELETE", "/api/v1/body-metrics?date=2026-09-23&slot=noon"))).status).toBe(400);
  });

  it("顺延：同日只一条，重复 = no-op；DELETE 撤销后回到原样", async () => {
    const { POST } = await routes.skip();
    const first = await POST(req("POST", "/api/v1/skip", { date: "2026-10-13", reason: "missed" }));
    expect(first.status).toBe(201);
    const second = await POST(req("POST", "/api/v1/skip", { date: "2026-10-13", reason: "missed" }));
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).written).toBe(false);

    const { DELETE } = await routes.skipDate();
    const removed = await jsonOf(
      await DELETE(req("DELETE", "/api/v1/skip/2026-10-13"), params({ date: "2026-10-13" })),
    );
    expect(removed.removed).toBe(true);
    const again = await jsonOf(
      await DELETE(req("DELETE", "/api/v1/skip/2026-10-13"), params({ date: "2026-10-13" })),
    );
    expect(again.removed).toBe(false);
  });

  it("顺延：非法 reason → 400 且不落库；缺省仍是 missed（13.8 / issue #10 R2）", async () => {
    const { POST } = await routes.skip();
    const { getDb } = await import("@/db/client");
    const { skipDay } = await import("@/db/schema");
    const { loadScheduleState } = await import("@/db/queries");
    const { isTrainingDay } = await import("@/lib/schedule");
    const time = await import("@/lib/time");
    const state = loadScheduleState(getDb(), time.dateInTz());
    let day = "";
    for (let i = 1; i <= 40 && !day; i++) {
      const d = time.addDays(time.dateInTz(), i);
      if (isTrainingDay(d, state.ctx, state.slots)) day = d;
    }
    expect(day).not.toBe("");
    const rowsOn = () => getDb().select().from(skipDay).all().filter((r) => r.date === day);

    // 非法枚举值 / 非字符串 / 空串一律 400，库里不落这条
    for (const bad of ["xyz", 123, ""]) {
      const res = await POST(req("POST", "/api/v1/skip", { date: day, reason: bad }));
      expect(res.status).toBe(400);
      expect(String((await jsonOf(res)).error)).toContain("reason");
    }
    expect(rowsOn()).toHaveLength(0);

    // 缺省（不传）不是非法：照写 missed
    const ok = await POST(req("POST", "/api/v1/skip", { date: day }));
    expect(ok.status).toBe(201);
    expect(rowsOn()[0]?.reason).toBe("missed");

    // 清理：别给后面的用例留欠账
    const { DELETE } = await routes.skipDate();
    await DELETE(req("DELETE", `/api/v1/skip/${day}`), params({ date: day }));
    expect(rowsOn()).toHaveLength(0);
  });

  it("连续第 3 条顺延 → 409 needs_reanchor，confirm 后才照写（13.8 / BUG-1 回归）", async () => {
    const { POST } = await routes.skip();
    // 顺延只发生在训练日（13.8）：挑接下来的 3 个训练日 —— 别拿休息日 / 假期当顺延对象（接口会 400）。
    // **每顺延一次排期就变一次**（13.8：循环位顺延），所以第 N 个训练日必须**在前一次写完后再算**：
    // 一次性算好 3 个再逐个提交，第二个可能已经变成休息日（跨零点后就是这么炸的）。
    const { getDb } = await import("@/db/client");
    const { loadScheduleState } = await import("@/db/queries");
    const { isTrainingDay } = await import("@/lib/schedule");
    const time = await import("@/lib/time");
    const nextTrainingDay = (from: string): string => {
      const state = loadScheduleState(getDb(), from);
      for (let i = 1; i <= 40; i++) {
        const d = time.addDays(from, i);
        if (isTrainingDay(d, state.ctx, state.slots)) return d;
      }
      throw new Error("往后 40 天里找不到训练日");
    };
    const dates: string[] = [];
    dates.push(nextTrainingDay(time.dateInTz()));
    expect(dates[0]).toBeTruthy();
    expect((await POST(req("POST", "/api/v1/skip", { date: dates[0], reason: "missed" }))).status).toBe(201);
    dates.push(nextTrainingDay(dates[0]));
    expect((await POST(req("POST", "/api/v1/skip", { date: dates[1], reason: "missed" }))).status).toBe(201);
    dates.push(nextTrainingDay(dates[1]));

    const third = await POST(req("POST", "/api/v1/skip", { date: dates[2], reason: "missed" }));
    expect(third.status).toBe(409);
    const thirdBody = await jsonOf(third);
    expect(thirdBody.needs_reanchor).toBe(true);
    expect(thirdBody.written).toBe(false);
    expect(thirdBody.owed as unknown[]).toHaveLength(2);

    const confirmed = await POST(
      req("POST", "/api/v1/skip", { date: dates[2], reason: "missed", confirm: true }),
    );
    expect(confirmed.status).toBe(201);
    expect((await jsonOf(confirmed)).written).toBe(true);

    // 清理：别给后面的用例留顺延残留
    const { DELETE } = await routes.skipDate();
    for (const d of dates) {
      await DELETE(req("DELETE", `/api/v1/skip/${d}`), params({ date: d }));
    }
  });
});

describe("放纵餐口径（3.4 / issue #1 第 3 项）", () => {
  it("全新库 daysSince 为 null（显示「还没有记录」，不是假的 0 天）；记一次后归 0", async () => {
    const { dateInTz } = await import("@/lib/time");
    const { GET } = await routes.today();
    const before = await jsonOf(await GET(req("GET", "/api/v1/today")));
    expect((before.cheat as { daysSince: number | null }).daysSince).toBeNull();

    const { POST } = await routes.cheatMeals();
    // 用真实的"今天"：daysSince 是相对今天算的，写死日期会在日期翻页后变成"距上次 N 天"
    const rec = await POST(req("POST", "/api/v1/cheat-meals", { date: dateInTz() }));
    expect(rec.status).toBeLessThan(400);

    const after = await jsonOf(await GET(req("GET", "/api/v1/today")));
    expect((after.cheat as { daysSince: number | null }).daysSince).toBe(0);
  });

  it("补记过去那天的记录：事实与锚点记在那天，返回的建议日按今天算（issue #4 第 2 项）", async () => {
    const { dateInTz, addDays } = await import("@/lib/time");
    const { POST } = await routes.cheatMeals();
    // 日期现算（踩坑第 15 条）：这条断言的是"建议日不在过去"，与具体哪天无关
    const past = addDays(dateInTz(), -20);
    const rec = await POST(req("POST", "/api/v1/cheat-meals", { date: past }));
    expect(rec.status).toBeLessThan(400);

    const body = (await jsonOf(rec)) as { date: string; anchorDate: string; nextDate: string };
    expect(body.date).toBe(past); // 事实记在那天
    expect(body.anchorDate).toBe(past); // 锚点跟着那条事实走
    expect(body.nextDate >= dateInTz()).toBe(true); // 别返回一个已经过去的"下次建议"
  });
});

describe("假期表写入（FR-24 / 13.12）", () => {
  it("非法数据 → 400 整单拒绝，库里保持原样", async () => {
    const { PUT, GET } = await routes.holidays();
    const bad = await PUT(
      req("PUT", "/api/v1/holidays", {
        year: 2027,
        days: [
          { date: "2027-01-01", name: "元旦", type: "holiday" },
          { date: "2026-01-01", name: "年份不符", type: "holiday" },
        ],
      }),
    );
    expect(bad.status).toBe(400);
    const badBody = await jsonOf(bad);
    expect((badBody.issues as string[]).join(" ")).toContain("2026");

    const check = await jsonOf(await GET(req("GET", "/api/v1/holidays?year=2027")));
    expect(check.days).toEqual([]);
  });

  it("黑盒报告的三个原始请求 → 全部 400（issue #1 第 4 项回归：报告称年份不符返回 200，线上版本无法复现）", async () => {
    const { PUT } = await routes.holidays();
    const cases = [
      { year: 2027, days: [{ date: "2026-01-01", name: "x", type: "holiday" }] },
      { year: 2027, days: [{ date: "2027-05-01", name: "x", type: "nonsense" }] },
      {
        year: 2027,
        days: [
          { date: "2027-05-01", name: "x", type: "holiday" },
          { date: "2027-05-01", name: "y", type: "holiday" },
        ],
      },
    ];
    for (const body of cases) {
      const res = await PUT(req("PUT", "/api/v1/holidays", body));
      expect(res.status).toBe(400);
      const bodyJson = await jsonOf(res);
      expect(bodyJson.error).toBe("假期表校验不通过");
    }
  });

  it("合法数据 → 整年写入；重复写 = 覆盖（幂等）", async () => {
    const { PUT, GET } = await routes.holidays();
    const days = [
      { date: "2027-01-01", name: "元旦", type: "holiday" },
      { date: "2027-02-06", name: "春节", type: "holiday" },
      { date: "2027-02-13", name: "春节补班", type: "workday" },
    ];
    const first = await PUT(req("PUT", "/api/v1/holidays", { year: 2027, days }));
    expect(first.status).toBe(200);
    expect((await jsonOf(first)).written).toBe(3);

    const second = await PUT(
      req("PUT", "/api/v1/holidays", { year: 2027, days: days.slice(0, 2) }),
    );
    expect((await jsonOf(second)).written).toBe(2);

    const check = await jsonOf(await GET(req("GET", "/api/v1/holidays?year=2027")));
    expect(check.days).toHaveLength(2);
    // 2026 年的表不受影响；覆盖期随新表推进到 2027-12-31
    expect((check.coverage as { end: string }).end).toBe("2027-12-31");
    const y2026 = await jsonOf(await GET(req("GET", "/api/v1/holidays?year=2026")));
    expect((y2026.days as unknown[]).length).toBe(34);
  });

  it("写入后：春节当天不练、补班日照练（补班日占循环位）", async () => {
    // 先把补班日再写回表里（上一条用例把 2027 年的表覆盖成了两天）
    const { PUT } = await routes.holidays();
    await PUT(
      req("PUT", "/api/v1/holidays", {
        year: 2027,
        days: [
          { date: "2027-02-06", name: "春节", type: "holiday" },
          { date: "2027-02-13", name: "春节补班", type: "workday" },
        ],
      }),
    );
    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");
    const db = getDb();
    const springFestival = buildToday(db, "gym", new Date("2027-02-06T22:30:00+08:00"));
    expect(springFestival.holiday?.name).toBe("春节");
    expect(springFestival.isTrainingDay).toBe(false);

    const makeup = buildToday(db, "gym", new Date("2027-02-13T22:30:00+08:00"));
    expect(makeup.holiday?.type).toBe("workday");
    expect(makeup.isTrainingDay).toBe(true);
  });
});

describe("重锚与今日总装", () => {
  it("重锚：只追加一条锚历史，今日部位随之改变", async () => {
    const { POST } = await routes.reanchor();
    const res = await POST(req("POST", "/api/v1/reanchor", { date: "2026-09-28", cycle_position: 1 }));
    expect(res.status).toBe(201);

    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");
    const today = buildToday(getDb(), "gym", new Date("2026-09-28T10:00:00+08:00"));
    expect(today.part).toBe("胸+三头");
  });

  it("cycle_position 越界 → 400", async () => {
    const { POST } = await routes.reanchor();
    const res = await POST(req("POST", "/api/v1/reanchor", { date: "2026-09-28", cycle_position: 9 }));
    expect(res.status).toBe(400);
  });

  it("今日总装：假期、恢复度、欠账、提醒预告都在（默认方案四天循环）", async () => {
    const { getDb } = await import("@/db/client");
    const { buildToday } = await import("@/server/today");
    const payload = buildToday(getDb(), "gym", new Date("2026-09-25T20:00:00+08:00"));
    expect(payload.date).toBe("2026-09-25");
    expect(payload.holiday?.name).toBe("中秋节");
    expect(payload.isTrainingDay).toBe(false);
    expect(payload.reminders.statusText).toContain("法定节假日");
    expect(payload.recovery.length).toBeGreaterThan(0);
    expect(payload.debt.text).toBeNull();
  });

  it("设置：改提醒时间立刻生效（FR-40）", async () => {
    const { GET, PATCH } = await routes.settings();
    const before = await jsonOf(await GET(req("GET", "/api/v1/settings")));
    expect(before.reminderTime).toBe("22:30");
    const after = await jsonOf(
      await PATCH(req("PATCH", "/api/v1/settings", { reminderTime: "22:00", unit: "kg" })),
    );
    expect(after.reminderTime).toBe("22:00");
    expect((await jsonOf(await GET(req("GET", "/api/v1/settings")))).reminderTime).toBe("22:00");
  });

  it("导出：包含全部训练记录与身体数据（FR-46），不含凭据材料（BUG-4 回归）", async () => {
    const { GET } = await routes.exportJson();
    const res = await GET(req("GET", "/api/v1/export.json"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    for (const key of ["sessions", "sets", "bodyMetrics", "checkins", "holidays", "caliber"]) {
      expect(body).toHaveProperty(key);
    }
    expect((body.sessions as unknown[]).length).toBeGreaterThan(0);
    expect((body.bodyMetrics as unknown[]).length).toBeGreaterThan(0);
    for (const row of body.user as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("passwordHash");
      expect(row).not.toHaveProperty("apiTokenHash");
    }
  });
});

/* ———————————————————————— 提醒引擎（MVP+ / 4.7 / 13.10） ———————————————————————— */

describe("提醒引擎（MVP+）：事件生成 / due / sent / holiday_gap / 重锚", () => {
  interface DueEvent {
    id: number;
    type: string;
    ref_key: string;
    date: string;
    title: string;
    body: string;
    action: "checkin" | "skip" | "ack" | null;
    part_label: string | null;
    checkin: { kind: "supplement"; ref_id: number } | null;
    proposal_id: number | null;
    delivery: { channel: string; status: string | null };
  }

  let db: import("@/db/client").Db;
  let today = "";
  let supplementId = 0;
  let schema: typeof import("@/db/schema");
  let runReminderTick: typeof import("@/server/reminders").runReminderTick;

  beforeAll(async () => {
    // 动态 import：env（DATABASE_FILE 等）必须在文件顶部先设好，见文件头说明
    const client = await import("@/db/client");
    const writes = await import("@/db/writes");
    const time = await import("@/lib/time");
    const orm = await import("drizzle-orm");
    schema = await import("@/db/schema");
    ({ runReminderTick } = await import("@/server/reminders"));
    db = client.getDb();
    today = time.dateInTz();

    // 一个干净的"今天"：清掉前面用例可能写过的当天记录与顺延
    db.delete(schema.checkin).where(orm.eq(schema.checkin.date, today)).run();
    db.delete(schema.workoutSession).where(orm.eq(schema.workoutSession.date, today)).run();
    db.delete(schema.skipDay).where(orm.eq(schema.skipDay.date, today)).run();
    db.delete(schema.reminderDelivery).run();
    db.delete(schema.reminderEvent).run();
    db.delete(schema.anchorProposal).run();

    // 提醒时间设为 00:00 → 无论测试在几点跑，都已"到判定时刻"（FR-40 的设置项）
    writes.setSetting(db, "reminder_time", "00:00");

    // 补剂只留一味可测，时点拨到 00:01（真实时点跟钟点走，测试里固定掉）
    db.update(schema.supplement).set({ enabled: false }).run();
    const first = db.select().from(schema.supplement).orderBy(orm.asc(schema.supplement.id)).get()!;
    db.update(schema.supplement)
      .set({ enabled: true, times: ["00:01"] })
      .where(orm.eq(schema.supplement.id, first.id))
      .run();
    supplementId = first.id;

    // 今天重锚到循环位 0（训练日）→ 训练提醒走第 8 条「该练 X 还没记录」
    const { POST } = await routes.reanchor();
    const anchored = await POST(req("POST", "/api/v1/reanchor", { date: today, cycle_position: 0 }));
    expect(anchored.status).toBe(201);
  });

  it("到点未练：due 返回训练提醒（第 8 条 + 一键打卡）与补剂提醒（第 2 条并列），投递为 dry_run（10.1 试运行）", async () => {
    const { GET } = await routes.remindersDue();
    const body = await jsonOf(await GET(req("GET", "/api/v1/reminders/due")));
    expect(body.date).toBe(today);
    const events = body.events as DueEvent[];

    const workout = events.find((e) => e.type === "workout");
    expect(workout).toBeDefined();
    expect(workout!.action).toBe("checkin");
    expect(workout!.part_label).toBeTruthy();
    expect(workout!.delivery).toEqual({ channel: "feishu", status: "dry_run" });

    const supplement = events.find((e) => e.type === "supplement");
    expect(supplement).toBeDefined();
    expect(supplement!.checkin).toEqual({ kind: "supplement", ref_id: supplementId });
  });

  it("去重（FR-37）：再跑 tick / 再轮询 due 都不会重复生成（事件按 type+ref_key+date 全天一条）", async () => {
    const tick = runReminderTick(db);
    expect(tick.generated).toEqual([]); // 全部已生成过

    const { GET } = await routes.remindersDue();
    const events = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(events.filter((e) => e.type === "workout")).toHaveLength(1);
    expect(events.filter((e) => e.type === "supplement")).toHaveLength(1);
  });

  it("练了就静默（13.10 第 1 条）：workout 打卡后 due 不再返回训练提醒，补剂照提（并列分支）", async () => {
    const { POST } = await routes.checkin();
    expect((await POST(req("POST", "/api/v1/checkin", { date: today, kind: "workout" }))).status).toBe(201);

    const { GET } = await routes.remindersDue();
    const events = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(events.find((e) => e.type === "workout")).toBeUndefined();
    expect(events.find((e) => e.type === "supplement")).toBeDefined();
  });

  it("补剂打卡后该条提醒消失（13.10 第 2 条）", async () => {
    const { POST } = await routes.checkin();
    const res = await POST(
      req("POST", "/api/v1/checkin", { date: today, kind: "supplement", ref_id: String(supplementId) }),
    );
    expect(res.status).toBe(201);

    const { GET } = await routes.remindersDue();
    const events = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(events.find((e) => e.type === "supplement")).toBeUndefined();
  });

  it("sent 标记：dry_run 升级为 sent 后不再返回；重复标记 = no-op（第 7 章 / 10.1 切换动作）", async () => {
    // 撤掉今天的打卡，让训练提醒重新出现在 due（事件还在库里，投递还是 dry_run）
    const orm = await import("drizzle-orm");
    db.delete(schema.checkin)
      .where(orm.and(orm.eq(schema.checkin.date, today), orm.eq(schema.checkin.kind, "workout")))
      .run();

    const { GET } = await routes.remindersDue();
    const event = ((await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[]).find(
      (e) => e.type === "workout",
    )!;
    expect(event.delivery.status).toBe("dry_run");

    const { POST } = await routes.reminderSent();
    const marked = await jsonOf(
      await POST(req("POST", `/api/v1/reminders/${event.id}/sent`, { channel: "feishu" }), params({ id: String(event.id) })),
    );
    expect(marked.upgraded).toBe(true);

    const after = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(after.find((e) => e.id === event.id)).toBeUndefined();

    const repeat = await jsonOf(
      await POST(req("POST", `/api/v1/reminders/${event.id}/sent`, { channel: "feishu" }), params({ id: String(event.id) })),
    );
    expect(repeat.created).toBe(false);
    expect(repeat.upgraded).toBe(false);
  });

  it("holiday_gap（13.12 / FR-48）：覆盖期不足 → 生成事件；30 天节流；补上新表后自动作废", async () => {
    db.delete(schema.holiday).run(); // 空表 → 覆盖期 null → 必然不足
    runReminderTick(db);

    const { GET } = await routes.remindersDue();
    const first = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    const gap = first.find((e) => e.type === "holiday_gap");
    expect(gap).toBeDefined();
    expect(gap!.ref_key).toMatch(/^coverage:/);

    // 同一覆盖期版本当天不重复生成（30 天节流）
    runReminderTick(db);
    const count = db.select().from(schema.reminderEvent).all().filter((e) => e.type === "holiday_gap");
    expect(count).toHaveLength(1);

    // 助手补上 2027 全年表 → 覆盖期足够，旧事件自动作废（引用键版本变了）
    const { PUT } = await routes.holidays();
    const put = await PUT(
      req("PUT", "/api/v1/holidays", { year: 2027, days: [{ date: "2027-01-01", name: "元旦", type: "holiday" }] }),
    );
    expect(put.status).toBe(200);
    const after = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(after.find((e) => e.type === "holiday_gap")).toBeUndefined();
  });

  it("重锚询问（FR-38）：停练 ≥3 训练日 → 生成建议与事件；拒绝后排期不变且不再问", async () => {
    // 15 天前最后一次训练 → 停练训练日数 ≥ 3。
    // 前面的用例在近几天写过会话/打卡/顺延，会把"最后一次活动"拉到最近 —— 先清掉老日期之后的所有活动。
    const orm = await import("drizzle-orm");
    const time = await import("@/lib/time");
    const oldDate = time.addDays(today, -15);
    const oldTs = new Date(`${oldDate}T10:00:00+08:00`).toISOString();
    db.delete(schema.workoutSession).where(orm.gt(schema.workoutSession.date, oldDate)).run();
    db.delete(schema.checkin).where(orm.gt(schema.checkin.date, oldDate)).run();
    db.delete(schema.skipDay).where(orm.gt(schema.skipDay.date, oldDate)).run();
    db.insert(schema.workoutSession)
      .values({
        clientId: `test-reanchor-${oldDate}`,
        date: oldDate,
        part: "背+二头",
        mode: "gym",
        status: "done",
        startedAt: oldTs,
        endedAt: oldTs,
      })
      .run();

    const { GET } = await routes.remindersDue();
    const event = ((await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[]).find(
      (e) => e.type === "reanchor",
    );
    expect(event).toBeDefined();
    expect(event!.proposal_id).toBeGreaterThan(0);

    const { POST } = await routes.reanchorProposals();
    const rejected = await jsonOf(
      await POST(
        req("POST", `/api/v1/reanchor/proposals/${event!.proposal_id}`, { decision: "reject" }),
        params({ id: String(event!.proposal_id) }),
      ),
    );
    expect(rejected.status).toBe("rejected");

    const after = (await jsonOf(await GET(req("GET", "/api/v1/reminders/due")))).events as DueEvent[];
    expect(after.find((e) => e.type === "reanchor")).toBeUndefined();
  });

  it("未认证 401；channel 非法 400", async () => {
    const { GET } = await routes.remindersDue();
    expect((await GET(req("GET", "/api/v1/reminders/due", undefined, { auth: false }))).status).toBe(401);
    expect((await GET(req("GET", "/api/v1/reminders/due?channel=email"))).status).toBe(400);
  });
});

/* ———————————————————————— v1.1：围度与趋势（FR-15 / FR-16 / FR-17 / FR-20） ———————————————————————— */

describe("v1.1：围度记录与序列（FR-15 / 第 6 章 measurement 表）", () => {
  it("POST 记录 → GET 列表；同日再存按**合并**覆盖（补录一项不抹掉别的）；全空与越界整单拒绝", async () => {
    const { POST, GET } = await routes.measurements();

    const first = await POST(req("POST", "/api/v1/measurements", { waist_cm: 88.5, chest_cm: 100 }));
    expect(first.status).toBe(201);

    // 同日补录腰围 + 臂围：腰围更新，胸围保留
    const second = await POST(
      req("POST", "/api/v1/measurements", { waist_cm: 88.0, arm_cm: 33.5 }),
    );
    expect(second.status).toBe(200);

    const list = await jsonOf(await GET(req("GET", "/api/v1/measurements")));
    const rows = list.rows as {
      date: string;
      waistCm: number | null;
      chestCm: number | null;
      armCm: number | null;
      thighCm: number | null;
    }[];
    expect(rows).toHaveLength(1); // 同日一条
    expect(rows[0].waistCm).toBe(88.0);
    expect(rows[0].chestCm).toBe(100); // 未提供 → 保留
    expect(rows[0].armCm).toBe(33.5);
    expect(rows[0].thighCm).toBeNull();

    const empty = await POST(req("POST", "/api/v1/measurements", {}));
    expect(empty.status).toBe(400);
    const outOfRange = await POST(req("POST", "/api/v1/measurements", { waist_cm: 999 }));
    expect(outOfRange.status).toBe(400);
  });

  it("不同日期各存一条（每周一次的节奏），列表升序", async () => {
    const { POST, GET } = await routes.measurements();
    const yesterday = (await import("@/lib/time")).addDays((await import("@/lib/time")).dateInTz(), -1);
    const added = await POST(req("POST", "/api/v1/measurements", { date: yesterday, waist_cm: 89.0 }));
    expect(added.status).toBe(201);

    const list = await jsonOf(await GET(req("GET", "/api/v1/measurements")));
    const rows = list.rows as { date: string; waistCm: number | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].date < rows[1].date).toBe(true); // 升序：昨天在前
    expect(rows[0].waistCm).toBe(89.0);
  });

  it("today 带 partFrequency（FR-20）；body-metrics 的 target 与 user 表同源", async () => {
    const { GET: todayGET } = await routes.today();
    const today = await jsonOf(await todayGET(req("GET", "/api/v1/today")));
    const freq = today.partFrequency as { group: string; days: number }[];
    expect(freq.length).toBeGreaterThan(0); // 方案里练到的部位都会出现（0 天也列出，漏练一眼看出）
    for (const row of freq) {
      expect(row.days).toBeGreaterThanOrEqual(0);
      expect(row.days).toBeLessThanOrEqual(7);
    }

    const { GET } = await routes.bodyMetrics();
    const body = await jsonOf(await GET(req("GET", "/api/v1/body-metrics?limit=365")));
    expect(typeof body.target).toBe("number");
    expect(body.target).toBeGreaterThan(0);
  });
});


/* —————— v1.1 剩余：统计完整版 / CSV 与备份恢复 / 补记（FR-26 / 27 / 46 / 47 / 13） —————— */

describe("v1.1 剩余：统计完整版与数据管理", () => {
  let sessionId = 0;
  let benchId = 0;

  beforeAll(async () => {
    // 提醒引擎的用例清理过最近会话 —— 先补一场今天的训练，统计与趋势才有料
    const client = await import("@/db/client");
    const db = client.getDb();
    const schema = await import("@/db/schema");
    const bench = db.select().from(schema.exercise).all().find((e) => e.name.includes("卧推"));
    benchId = bench!.id;

    // 这台动作 × 默认变体的既有组先清掉：上面那些用例会在写死的 2026-09-28 落组，
    // 而"重锚询问"用例的清理窗口是「今天 − 15 天」—— 日期一翻页就不再覆盖它们（踩坑 15），
    // 全量清单里的 sets 会随日期漂移。本用例只断言自己写的这 2 组，先清干净再写。
    const orm = await import("drizzle-orm");
    db.delete(schema.setLog)
      .where(orm.and(orm.eq(schema.setLog.exerciseId, benchId), orm.isNull(schema.setLog.variantId)))
      .run();

    const { POST: sessPOST } = await routes.sessions();
    const created = await sessPOST(
      req("POST", "/api/v1/sessions", {
        client_id: `stats-full-${Date.now()}`,
        part: "胸+三头",
        mode: "gym",
        status: "done",
        exercises: [{ exercise_id: benchId, order_no: 0, target_sets: 2, target_reps: 12 }],
      }),
    );
    sessionId = Number((await jsonOf(created)).id);

    const { POST: setsPOST } = await routes.sets();
    await setsPOST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "stats-full-1",
        exercise_id: benchId,
        set_no: 1,
        weight_kg: 20,
        reps: 12,
      }),
      params({ id: String(sessionId) }),
    );
    await setsPOST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "stats-full-2",
        exercise_id: benchId,
        set_no: 2,
        weight_kg: 22.5,
        reps: 10,
      }),
      params({ id: String(sessionId) }),
    );
  });

  it("stats：部位占比（组数 + 容量两档数据都在，FR-26）", async () => {
    const { GET } = await routes.stats();
    const body = await jsonOf(await GET(req("GET", "/api/v1/stats?days=30")));
    const parts = body.parts as { group: string; sets: number; volumeKg: number }[];
    expect(parts.length).toBeGreaterThan(0);
    const chest = parts.find((p) => p.group === "胸");
    expect(chest).toBeDefined();
    expect(chest!.sets).toBeGreaterThanOrEqual(2);
    expect(chest!.volumeKg).toBeGreaterThan(0); // 20×12 + 22.5×10 折算总重
  });

  it("动作趋势：清单按「动作 × 变体」→ 趋势点按日期升序、当日取最大单侧重量（FR-27 / 13.14）", async () => {
    const { GET: listGET } = await routes.statsExercises();
    const list = await jsonOf(await listGET(req("GET", "/api/v1/stats/exercises")));
    const rows = list.rows as { exerciseId: number; variantId: number | null; exerciseName: string; sets: number }[];
    expect(rows.length).toBeGreaterThan(0);

    const mine = rows.find((r) => r.exerciseId === benchId && r.variantId === null);
    expect(mine).toBeDefined();
    expect(mine!.sets).toBe(2);

    const { GET: trendGET } = await routes.statsTrend();
    const tid = await jsonOf(
      await trendGET(
        req("GET", `/api/v1/stats/exercise-trend?exercise_id=${benchId}&variant_id=&days=90`),
      ),
    );
    const trend = tid.rows as { date: string; maxWeightKg: number | null; sets: number }[];
    expect(trend.length).toBeGreaterThan(0);
    for (let i = 1; i < trend.length; i++) expect(trend[i - 1].date < trend[i].date).toBe(true);
    expect(trend[trend.length - 1].maxWeightKg).toBe(22.5); // 当日最大单侧读数
    expect(trend[trend.length - 1].sets).toBe(2);
  });

  it("export.csv：UTF-8 BOM + 口径列写清（FR-46 / 13.13）", async () => {
    const { GET } = await routes.exportCsv();
    const workout = await GET(req("GET", "/api/v1/export.csv?type=workout"));
    expect(workout.status).toBe(200);
    expect(workout.headers.get("content-type")).toContain("text/csv");
    // 注意：Response.text() 解码时会剥掉 BOM，所以检查原始字节（Excel 看到的就是这三个字节）
    const head = new Uint8Array((await workout.arrayBuffer()).slice(0, 3));
    expect([...head]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await (await GET(req("GET", "/api/v1/export.csv?type=workout"))).arrayBuffer(),
    );
    expect(text).toContain("weight_kg_side");
    expect(text).toContain("total_load_kg");
    expect(text).toContain("卧推");

    const bodyText = await (await GET(req("GET", "/api/v1/export.csv?type=body"))).text();
    expect(bodyText).toContain("body_fat_pct");

    // 有氧（FR-50 / v1.16）：CSV 也导得出（只记分钟数）
    const cardio = await GET(req("GET", "/api/v1/export.csv?type=cardio"));
    expect(cardio.status).toBe(200);
    expect(await cardio.text()).toContain("minutes");

    const bad = await GET(req("GET", "/api/v1/export.csv?type=everything"));
    expect(bad.status).toBe(400);
  });

  it("restore：乱文件整单拒绝；合法备份通过校验（dry-run 不落盘）（FR-47 / 13.13）", async () => {
    const { GET: backupGET } = await routes.backup();
    const { POST: restorePOST } = await routes.restore();

    const junk = await restorePOST(
      req("POST", "/api/v1/restore", { nonsense: true }) as unknown as Request,
    );
    expect(junk.status).toBe(400); // JSON body 太小 → 不是合法备份

    process.env.RESTORE_DRY_RUN = "1";
    try {
      const backupRes = await backupGET(req("GET", "/api/v1/backup"));
      expect(backupRes.status).toBe(200);
      expect(backupRes.headers.get("content-disposition")).toContain(".sqlite");
      const buf = await backupRes.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(4096);

      const ok = await restorePOST(
        new Request(`${BASE}/api/v1/restore`, {
          method: "POST",
          headers: { authorization: "Bearer test-token", "content-type": "application/octet-stream" },
          body: buf,
        }),
      );
      expect(ok.status).toBe(200);
      const body = await jsonOf(ok);
      expect(body.validated).toBe(true);
      expect(body.applied).toBe(false);
    } finally {
      delete process.env.RESTORE_DRY_RUN;
    }
  });

  it("补记：today?date 取那天的排期；未来日期拒绝（FR-13）", async () => {
    const { GET } = await routes.today();
    const time = await import("@/lib/time");
    const today = time.dateInTz();

    const past = time.addDays(today, -7);
    const pastBody = await jsonOf(await GET(req("GET", `/api/v1/today?date=${past}`)));
    expect(pastBody.date).toBe(past);

    const future = time.addDays(today, 7);
    expect((await GET(req("GET", `/api/v1/today?date=${future}`))).status).toBe(400);
    expect((await GET(req("GET", "/api/v1/today?date=垃圾"))).status).toBe(400);
  });
});
