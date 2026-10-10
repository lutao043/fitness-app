/**
 * v1.18 收口批的接口级测试：热身（FR-53，v1.26 改写为练前提示）、补明细（FR-13）、
 * 动作级组间歇（FR-52）、方案导出 / 导入（FR-54）、提醒判定演练（FR-55）。
 *
 * 重点钉住的都是**口径**：
 * - 热身不再记录（v1.26）：写接口传 `is_warmup: true` 一律 400；老数据里 `is_warmup = 1`
 *   的行照旧不计容量 / 不占目标组数 / 不参与预填与趋势 / 不进组间歇统计；
 * - 补录的组 `rest_before_sec = null`（不编假间隔），且补完小结立刻重算落库；
 * - 方案导入按名字匹配，缺动作整单拒绝；
 * - 演练只读：不生成事件、不写去重与投递记录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-v118-"));
process.env.DATABASE_FILE = join(dir, "v118.sqlite");
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

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

async function jsonOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const routes = {
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { GET: Handler; POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { GET: Handler; PATCH: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  stats: async () => (await import("@/app/api/v1/stats/route")) as { GET: Handler },
  exercises: async () => (await import("@/app/api/v1/exercises/route")) as { GET: Handler; POST: Handler },
  exercise: async () => (await import("@/app/api/v1/exercises/[id]/route")) as { PATCH: Handler },
  schemes: async () => (await import("@/app/api/v1/schemes/route")) as { GET: Handler },
  schemeExport: async () => (await import("@/app/api/v1/schemes/[id]/export/route")) as { GET: Handler },
  schemeImport: async () => (await import("@/app/api/v1/schemes/import/route")) as { POST: Handler },
  reminderPreview: async () => (await import("@/app/api/v1/reminders/preview/route")) as { GET: Handler },
  checkin: async () => (await import("@/app/api/v1/checkin/route")) as { POST: Handler },
  exportCsv: async () => (await import("@/app/api/v1/export.csv/route")) as { GET: Handler },
};

async function countRows(table: "reminder_event" | "reminder_delivery") {
  const { getDb } = await import("@/db/client");
  const schema = await import("@/db/schema");
  return getDb().select().from(table === "reminder_event" ? schema.reminderEvent : schema.reminderDelivery).all().length;
}

let benchPressId = 0;
let pullUpId = 0;
let today = "";

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  // 首次访问即触发建库 + 种子
  const { GET } = await routes.today();
  expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
  const { getDb } = await import("@/db/client");
  const { exercise } = await import("@/db/schema");
  const all = getDb().select().from(exercise).all();
  benchPressId = all.find((e) => e.name === "平板卧推")!.id;
  pullUpId = all.find((e) => e.name === "引体向上")!.id;
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

/** 建一场做训练中的会话（测试里到处要用） */
async function newDoingSession(clientId: string, date: string, part = "胸+三头", exercises: unknown[] = []) {
  const { POST } = await routes.sessions();
  const res = await POST(
    req("POST", "/api/v1/sessions", {
      client_id: clientId,
      part,
      mode: "gym",
      status: "doing",
      started_at: `${date}T10:00:00+08:00`,
      exercises,
    }),
  );
  expect(res.status).toBe(201);
  return Number((await jsonOf<{ id: number }>(res)).id);
}

async function pushSet(
  sessionId: number,
  body: {
    clientKey: string;
    exerciseId: number;
    setNo: number;
    weightKg?: number;
    reps?: number;
    doneAt: string;
    feel?: string;
    backfill?: boolean;
  },
) {
  const { POST } = await routes.sets();
  return POST(
    req("POST", `/api/v1/sessions/${sessionId}/sets`, {
      client_key: body.clientKey,
      exercise_id: body.exerciseId,
      set_no: body.setNo,
      weight_kg: body.weightKg,
      reps: body.reps,
      done_at: body.doneAt,
      ...(body.feel ? { feel: body.feel } : {}),
      ...(body.backfill ? { backfill: true } : {}),
    }),
    params({ id: String(sessionId) }),
  );
}

/* ———————————————————— 热身（v1.26 起不再记录；老数据照旧排除） ———————————————————— */

describe("热身：不再记录，历史行仍不算训练量", () => {
  let sessionId = 0;
  const date = "2026-09-20";

  it("传 is_warmup: true → 400 且不落库（写入口已取消，v1.26）", async () => {
    sessionId = await newDoingSession("warmup-session", date, "胸+三头", [
      { exercise_id: benchPressId, target_sets: 4, target_reps: 12 },
    ]);
    const { POST } = await routes.sets();
    const rejected = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "warm-rejected-1",
        exercise_id: benchPressId,
        set_no: 1,
        weight_kg: 40,
        reps: 10,
        is_warmup: true,
        done_at: `${date}T10:00:00+08:00`,
      }),
      params({ id: String(sessionId) }),
    );
    expect(rejected.status).toBe(400);
    expect(String((await jsonOf<{ error: string }>(rejected)).error)).toContain("热身");

    const { GET } = await routes.session();
    const detail = await jsonOf<{ sets: unknown[] }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.sets).toHaveLength(0); // 那一组都没落
  });

  it("老数据里的热身行：读数照存，但不计容量 / 组数，也不参与「照上次填」", async () => {
    // v1.18–v1.25 时期的热身组只能以老数据形式存在（接口已不收 is_warmup）：
    // 直接入库两行模拟（2 组 40 kg/侧 ×10 → 总重 100）。done_at 特意比正式组更晚 ——
    // 排除口径失效时，「照上次填」会变成 40 而不是正式组的 20。
    const { getSqlite } = await import("@/db/client");
    const insert = getSqlite().prepare(
      "INSERT INTO set_log (client_key, session_id, exercise_id, set_no, weight_kg, reps, total_load_kg, done_at, is_warmup) VALUES (?, ?, ?, ?, 40, 10, 100, ?, 1)",
    );
    insert.run(1, sessionId, benchPressId, 5, `${date}T10:10:00+08:00`);
    insert.run(2, sessionId, benchPressId, 6, `${date}T10:11:00+08:00`);

    // 4 组正式（20 kg/侧 ×12 → 总重 60、单组容量 720）；最后一次写组会把小结重算落库
    for (let i = 1; i <= 4; i++) {
      const res = await pushSet(sessionId, {
        clientKey: `warm-work-${i}`,
        exerciseId: benchPressId,
        setNo: i,
        weightKg: 20,
        reps: 12,
        doneAt: `${date}T10:0${i}:00+08:00`,
      });
      expect(res.status).toBe(201);
    }

    const { GET } = await routes.session();
    const detail = await jsonOf<{
      summary: { totalSets: number; volumeKg: number };
      sets: { isWarmup: boolean }[];
      prefill: Record<string, Record<string, { weightKg: number | null }>>;
    }>(await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })));

    expect(detail.sets).toHaveLength(6); // 读数都照存（详情页要看得到）
    expect(detail.sets.filter((s) => s.isWarmup)).toHaveLength(2);
    expect(detail.summary.totalSets).toBe(4);
    expect(detail.summary.volumeKg).toBe(4 * 720);
    expect(detail.prefill[String(benchPressId)]?.default?.weightKg).toBe(20);
  });

  it("统计页（容量 / 组数 / 部位占比）同样不含老热身行", async () => {
    const { GET } = await routes.stats();
    const stats = await jsonOf<{ totalSets: number; parts: { group: string; sets: number }[] }>(
      await GET(req("GET", "/api/v1/stats?days=90")),
    );
    // 只有这一场有明细：正式 4 组（老热身 2 组不算）
    expect(stats.totalSets).toBe(4);
    expect(stats.parts.find((p) => p.group === "胸")?.sets).toBe(4);
  });

  it("CSV 导出保留 is_warmup 列（老数据仍标得出哪几行是热身）", async () => {
    const { GET } = await routes.exportCsv();
    const res = await GET(req("GET", "/api/v1/export.csv?type=workout"));
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim() !== "");
    const idx = lines[0].split(",").indexOf("is_warmup");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines.slice(1).filter((l) => l.split(",")[idx] === "1")).toHaveLength(2);
  });
});

/* ———————————————————— 补明细（FR-13 v1.18） ———————————————————— */

describe("补明细：补录的组不记组间歇，补完立刻重算小结", () => {
  it("POST /sessions status=done（补录）：小结落库 + 自动打卡", async () => {
    const { POST } = await routes.sessions();
    const res = await POST(
      req("POST", "/api/v1/sessions", {
        client_id: "backfill-session",
        date: "2026-09-18",
        part: "背+二头",
        mode: "gym",
        status: "done",
        exercises: [{ exercise_id: pullUpId, target_sets: 4, target_reps: 8 }],
      }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: number; summary: { totalSets: number; minutes: number } }>(res);
    expect(body.summary.totalSets).toBe(0); // 还没补组
    expect(body.summary.minutes).toBe(0); // 补录没记时长（不编开始时间）

    const { GET: todayGET } = await routes.today();
    const day = await jsonOf<{ checkin: { workout: boolean } }>(
      await todayGET(req("GET", "/api/v1/today?date=2026-09-18")),
    );
    expect(day.checkin.workout).toBe(true);
  });

  it("backfill 的组 rest_before_sec = null；同一场的正常组照记间隔", async () => {
    const sessionId = await newDoingSession("backfill-sets", "2026-09-19");
    // 正常一组（10:00）→ 第二组 10:10，间隔 600 秒
    const first = await pushSet(sessionId, {
      clientKey: "bf-normal-1",
      exerciseId: benchPressId,
      setNo: 1,
      weightKg: 20,
      reps: 10,
      doneAt: "2026-09-19T10:00:00+08:00",
    });
    expect(first.status).toBe(201);
    const second = await pushSet(sessionId, {
      clientKey: "bf-normal-2",
      exerciseId: benchPressId,
      setNo: 2,
      weightKg: 20,
      reps: 10,
      doneAt: "2026-09-19T10:10:00+08:00",
    });
    expect((await jsonOf<{ restBeforeSec: number | null }>(second)).restBeforeSec).toBe(600);

    // 补录的一组：不记间隔（不然"补录时刻 − 上一组"会是一个几小时的假间隔）
    const back = await pushSet(sessionId, {
      clientKey: "bf-backfill-3",
      exerciseId: benchPressId,
      setNo: 3,
      weightKg: 22.5,
      reps: 10,
      doneAt: new Date().toISOString(),
      backfill: true,
    });
    expect(back.status).toBe(201);
    const backBody = await jsonOf<{ restBeforeSec: number | null; totalLoadKg: number }>(back);
    expect(backBody.restBeforeSec).toBeNull();
    expect(backBody.totalLoadKg).toBe(65); // 22.5×2+20：读数照算

    const { GET } = await routes.session();
    const detail = await jsonOf<{ summary: { totalSets: number; volumeKg: number; avgRestSec: number } }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.summary.totalSets).toBe(3); // 补的那组也算正式组
    expect(detail.summary.volumeKg).toBe(60 * 10 + 60 * 10 + 65 * 10);
    expect(detail.summary.avgRestSec).toBe(600); // 补录的组不进均值
  });

  it("给已收工的会话补一组 → 小结落库（记录页与今日页同时看到新组数）", async () => {
    const { PATCH, GET } = await routes.session();
    const sessionId = await newDoingSession("backfill-done", "2026-09-17");
    const one = await pushSet(sessionId, {
      clientKey: "bf-done-1",
      exerciseId: benchPressId,
      setNo: 1,
      weightKg: 20,
      reps: 10,
      doneAt: "2026-09-17T10:00:00+08:00",
    });
    expect(one.status).toBe(201);
    // 收工
    const done = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}`, { status: "done", ended_at: "2026-09-17T11:00:00+08:00" }),
      params({ id: String(sessionId) }),
    );
    expect((await jsonOf<{ summary: { totalSets: number } }>(done)).summary.totalSets).toBe(1);

    // 事后补一组
    const added = await pushSet(sessionId, {
      clientKey: "bf-done-2",
      exerciseId: benchPressId,
      setNo: 2,
      weightKg: 22.5,
      reps: 8,
      doneAt: "2026-09-17T11:30:00+08:00",
      backfill: true,
    });
    expect(added.status).toBe(201);

    // GET 详情读的是落库小结（不是现算）—— 必须已经是 2 组
    const detail = await jsonOf<{ summary: { totalSets: number; volumeKg: number } }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.summary.totalSets).toBe(2);
    expect(detail.summary.volumeKg).toBe(60 * 10 + 65 * 8);
  });

  it("已收工的会话允许「补一个动作」（aborted 仍拒绝）", async () => {
    const { GET, PATCH } = await routes.session();
    const { POST } = await import("@/app/api/v1/sessions/[id]/exercises/route");
    const sessionId = await newDoingSession("backfill-exercise", "2026-09-16");
    await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}`, { status: "done", ended_at: "2026-09-16T11:00:00+08:00" }),
      params({ id: String(sessionId) }),
    );
    const added = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/exercises`, {
        exercise_id: pullUpId,
        target_sets: 3,
        target_reps: 8,
      }),
      params({ id: String(sessionId) }),
    );
    expect(added.status).toBe(201);
    const detail = await jsonOf<{ exercises: { exerciseId: number }[] }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.exercises.some((e) => e.exerciseId === pullUpId)).toBe(true);
  });
});

/* ———————————————————— 动作级组间歇（FR-52） ———————————————————— */

describe("动作级组间歇（FR-52）", () => {
  it("生效优先级：本次临时档 > 动作级默认 > 会话/全局默认（纯函数）", async () => {
    const { effectiveRestSec, DEFAULT_REST_SEC } = await import("@/lib/caliber");
    expect(effectiveRestSec({ overrideSec: 60, exerciseRestSec: 120, sessionRestSec: 90 })).toBe(60);
    expect(effectiveRestSec({ exerciseRestSec: 120, sessionRestSec: 90 })).toBe(120);
    expect(effectiveRestSec({ exerciseRestSec: null, sessionRestSec: 75 })).toBe(75);
    expect(effectiveRestSec({ overrideSec: null, exerciseRestSec: null, sessionRestSec: 90 })).toBe(90);
    expect(effectiveRestSec({ sessionRestSec: 0 })).toBe(DEFAULT_REST_SEC); // 脏值退回默认
  });

  it("动作库能存 rest_sec（10~600 整数），出界整条拒绝，可清空回全局默认", async () => {
    const { POST, GET } = await routes.exercises();
    const created = await POST(
      req("POST", "/api/v1/exercises", {
        name: "测试-组间歇动作",
        muscles: ["胸"],
        type: "weight",
        equip: "哑铃",
        load_mode: "dumbbell",
        sets: 3,
        reps: 12,
        rest_sec: 120,
      }),
    );
    expect(created.status).toBe(201);
    const id = (await jsonOf<{ id: number }>(created)).id;

    const library = await jsonOf<{ exercises: { id: number; restSec: number | null }[] }>(
      await GET(req("GET", "/api/v1/exercises")),
    );
    expect(library.exercises.find((e) => e.id === id)?.restSec).toBe(120);

    const bad = await POST(
      req("POST", "/api/v1/exercises", {
        name: "测试-组间歇越界",
        muscles: ["胸"],
        type: "weight",
        equip: "哑铃",
        load_mode: "dumbbell",
        sets: 3,
        reps: 12,
        rest_sec: 5,
      }),
    );
    expect(bad.status).toBe(400);
    expect(((await jsonOf<{ issues: string[] }>(bad)).issues ?? []).join()).toContain("组间歇");

    const { PATCH } = await routes.exercise();
    const cleared = await PATCH(
      req("PATCH", `/api/v1/exercises/${id}`, { rest_sec: null }),
      params({ id: String(id) }),
    );
    expect(cleared.status).toBe(200);
    const after = await jsonOf<{ exercises: { id: number; restSec: number | null }[] }>(
      await GET(req("GET", "/api/v1/exercises")),
    );
    expect(after.exercises.find((e) => e.id === id)?.restSec).toBeNull();
  });
});

/* ———————————————————— 方案导出 / 导入（FR-54） ———————————————————— */

describe("方案导出 / 导入（FR-54）", () => {
  it("导出的方案能原样导入成新方案（槽位、两套清单、目标组数次数一致）", async () => {
    const { GET: schemesGET } = await routes.schemes();
    const payload = await jsonOf<{ schemes: { id: string }[]; activeSchemeId: string }>(
      await schemesGET(req("GET", "/api/v1/schemes")),
    );
    const sourceId = payload.activeSchemeId;

    const { GET: exportGET } = await routes.schemeExport();
    const exported = await jsonOf<{
      kind: string;
      version: number;
      name: string;
      slots: { label: string; gym: { name: string; sets: number; reps: number }[] }[];
    }>(await exportGET(req("GET", `/api/v1/schemes/${sourceId}/export`), params({ id: sourceId })));
    expect(exported.kind).toBe("fitness-app.scheme");
    expect(exported.version).toBe(1);
    expect(exported.slots.length).toBeGreaterThan(1);

    const { POST: importPOST } = await routes.schemeImport();
    const imported = await importPOST(
      req("POST", "/api/v1/schemes/import", { ...exported, name: `${exported.name} 导入` }),
    );
    expect(imported.status).toBe(201);
    const newId = (await jsonOf<{ id: string }>(imported)).id;

    const after = await jsonOf<{
      schemes: {
        id: string;
        name: string;
        slots: { label: string; gym: { name: string; targetSets: number; targetReps: number }[] }[];
      }[];
      activeSchemeId: string;
    }>(await schemesGET(req("GET", "/api/v1/schemes")));
    const created = after.schemes.find((s) => s.id === newId)!;
    expect(created.slots.map((s) => s.label)).toEqual(exported.slots.map((s) => s.label));
    expect(created.slots.map((s) => s.gym.map((e) => ({ name: e.name, sets: e.targetSets, reps: e.targetReps })))).toEqual(
      exported.slots.map((s) => s.gym),
    );
    // 导入不切换当前方案
    expect(after.activeSchemeId).toBe(sourceId);
  });

  it("重名整单拒绝；缺动作会列出名字（不做部分导入）", async () => {
    const { POST: importPOST } = await routes.schemeImport();
    const base = {
      kind: "fitness-app.scheme",
      version: 1,
      name: "四天循环",
      note: "",
      slots: [{ label: "胸", rest: false, muscles: ["胸"], gym: [], home: [] }],
    };
    const dup = await importPOST(req("POST", "/api/v1/schemes/import", base));
    expect(dup.status).toBe(400);
    expect((await jsonOf<{ error: string }>(dup)).error).toContain("已经有叫");

    const missing = await importPOST(
      req("POST", "/api/v1/schemes/import", {
        ...base,
        name: "缺动作的方案",
        slots: [
          {
            label: "胸",
            rest: false,
            muscles: ["胸"],
            gym: [{ name: "这个动作不存在", sets: 4, reps: 12 }],
            home: [],
          },
        ],
      }),
    );
    expect(missing.status).toBe(400);
    expect((await jsonOf<{ error: string }>(missing)).error).toContain("这个动作不存在");

    const badKind = await importPOST(req("POST", "/api/v1/schemes/import", { ...base, kind: "other", name: "别的" }));
    expect(badKind.status).toBe(400);
  });
});

/* ———————————————————— 提醒判定演练（FR-55） ———————————————————— */

describe("提醒判定演练：只读、与判定表一致", () => {
  it("演练不写任何事件与投递记录", async () => {
    const beforeEvents = await countRows("reminder_event");
    const beforeDeliveries = await countRows("reminder_delivery");

    const { GET } = await routes.reminderPreview();
    const preview = await jsonOf<{ sideEffects: { eventsWritten: number; deliveriesWritten: number } }>(
      await GET(req("GET", "/api/v1/reminders/preview?at=22:30")),
    );
    expect(preview.sideEffects).toEqual({ eventsWritten: 0, deliveriesWritten: 0 });
    expect(await countRows("reminder_event")).toBe(beforeEvents);
    expect(await countRows("reminder_delivery")).toBe(beforeDeliveries);
  });

  it("结论与当天事实一致：没记录 → 会发；练了 → 静默（含 doing）", async () => {
    const { GET: previewGET } = await routes.reminderPreview();
    const { GET: todayGET } = await routes.today();
    const day = await jsonOf<{
      isTrainingDay: boolean;
      isRestDay: boolean;
      holiday: unknown;
      session: unknown;
      checkin: { workout: boolean };
    }>(await todayGET(req("GET", "/api/v1/today")));

    const before = await jsonOf<{ decision: { verdict: string; reason: string; action: string | null } }>(
      await previewGET(req("GET", "/api/v1/reminders/preview?at=22:30")),
    );
    if (day.isTrainingDay && !day.isRestDay && !day.holiday && !day.session && !day.checkin.workout) {
      expect(before.decision.verdict).toBe("send");
      expect(before.decision.reason).toBe("prompt");
      expect(before.decision.action).toBe("checkin");
    }

    // 练了就静默（doing 也算）—— 建一场今天的 doing 会话再看
    await newDoingSession("preview-today", today);
    const after = await jsonOf<{ decision: { verdict: string; reason: string; hitNo: number } }>(
      await previewGET(req("GET", "/api/v1/reminders/preview?at=22:30")),
    );
    expect(after.decision.verdict).toBe("silent");
    expect(after.decision.reason).toBe("recorded");
    expect(after.decision.hitNo).toBe(1);

    // 判定时刻早于配置的提醒时间 → 标注出来
    const early = await jsonOf<{ decision: { beforeCheckTime: boolean } }>(
      await previewGET(req("GET", "/api/v1/reminders/preview?at=06:00")),
    );
    expect(early.decision.beforeCheckTime).toBe(true);
  });

  it("判定链每条都带命中情况与说明（页面就是照它渲染的）", async () => {
    const { GET } = await routes.reminderPreview();
    const preview = await jsonOf<{ decision: { steps: { no: number; name: string; hit: boolean; detail: string }[] } }>(
      await GET(req("GET", "/api/v1/reminders/preview?at=22:30")),
    );
    expect(preview.decision.steps.map((s) => s.no)).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
    expect(preview.decision.steps.every((s) => s.name.length > 0 && s.detail.length > 0)).toBe(true);
  });

  it("补剂：打卡过的那条不再提", async () => {
    const { GET } = await routes.reminderPreview();
    const first = await jsonOf<{ supplements: { id: number; name: string; verdict: { due: boolean; reason: string } }[] }>(
      await GET(req("GET", "/api/v1/reminders/preview?at=23:59")),
    );
    const target = first.supplements[0];
    expect(target).toBeTruthy();
    expect(["due", "not_yet"]).toContain(target.verdict.reason);

    const { POST } = await routes.checkin();
    const checked = await POST(req("POST", "/api/v1/checkin", { kind: "supplement", ref_id: String(target.id) }));
    expect(checked.status).toBeLessThan(300);

    const second = await jsonOf<{ supplements: { id: number; verdict: { due: boolean; reason: string } }[] }>(
      await GET(req("GET", "/api/v1/reminders/preview?at=23:59")),
    );
    expect(second.supplements.find((s) => s.id === target.id)?.verdict.reason).toBe("taken");
  });

  it("非法参数：at 不是 HH:mm、date 是未来 → 400", async () => {
    const { GET } = await routes.reminderPreview();
    expect((await GET(req("GET", "/api/v1/reminders/preview?at=25:00"))).status).toBe(400);
    expect((await GET(req("GET", "/api/v1/reminders/preview?date=2099-01-01"))).status).toBe(400);
  });
});
