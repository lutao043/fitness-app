/**
 * 加练（需求书 13.17）的接口级测试：
 * - 非训练日开练（`extra: true`）才写循环位点；训练日 / 休槽位 / 补录 / 非今天一律 400；
 * - 位点落库后：今天没休的「休」顺延到明天、加练部位的下一次排期换成它的下一位；
 * - 幂等（同一 client_id 重复提交不写第二条）、撤销（置 aborted / 删掉会话 → 位点一起撤）；
 * - 13.11 的"加班只在训练日判定"：休息日的加班记录带 `day_type`，提醒判定照 13.10 第 4 条静默。
 *
 * 与 tests/unit/rules.test.ts 同一套做法：对着真实路由处理器跑，数据库换成临时文件。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dateInTz, type DateStr } from "@/lib/time";

const dir = mkdtempSync(join(tmpdir(), "fitness-extra-"));
process.env.DATABASE_FILE = join(dir, "extra.sqlite");
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
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { PATCH: Handler; DELETE: Handler },
  overtime: async () => (await import("@/app/api/v1/overtime/route")) as { GET: Handler; POST: Handler },
  reanchor: async () => (await import("@/app/api/v1/reanchor/route")) as { POST: Handler },
  skip: async () => (await import("@/app/api/v1/skip/route")) as { POST: Handler },
  schemes: async () => (await import("@/app/api/v1/schemes/route")) as { GET: Handler },
};

const today = dateInTz();

interface SlotView {
  templateId: number;
  position: number;
  label: string;
  rest: boolean;
}

let slots: SlotView[] = [];
let restSlot: SlotView;
let firstSlot: SlotView;

async function activeSlots(): Promise<SlotView[]> {
  const { GET } = await routes.schemes();
  const body = await jsonOf<{ schemes: { id: string; active: boolean; slots: SlotView[] }[]; activeSchemeId: string }>(
    await GET(req("GET", "/api/v1/schemes")),
  );
  const active = body.schemes.find((s) => s.id === body.activeSchemeId) ?? body.schemes[0];
  return active.slots;
}

/** 直接读排期（未来日期只能这么断言：`/today?date=` 不吃未来） */
async function scheduleOn(date: DateStr) {
  const { getDb } = await import("@/db/client");
  const { loadScheduleState } = await import("@/db/queries");
  const { slotOf } = await import("@/lib/schedule");
  const state = loadScheduleState(getDb(), date);
  return slotOf(date, state.ctx, state.slots)?.label ?? "";
}

async function pointCount(): Promise<number> {
  const { getSqlite } = await import("@/db/client");
  return (getSqlite().prepare("select count(*) as c from cycle_point").get() as { c: number }).c;
}

async function sessionRows(): Promise<{ id: number; is_extra: number; status: string }[]> {
  const { getSqlite } = await import("@/db/client");
  return getSqlite().prepare("select id, is_extra, status from workout_session order by id").all() as {
    id: number;
    is_extra: number;
    status: string;
  }[];
}

async function skipCount(): Promise<number> {
  const { getSqlite } = await import("@/db/client");
  return (getSqlite().prepare("select count(*) as c from skip_day").get() as { c: number }).c;
}

/** 把今天重锚到指定位次（测试要自己摆一个"今天是休息日 / 训练日"的场面） */
async function anchorToday(position: number) {
  const { POST } = await routes.reanchor();
  const res = await POST(req("POST", "/api/v1/reanchor", { date: today, cycle_position: position, reason: "manual" }));
  expect(res.status).toBe(201);
}

function extraBody(overrides: Record<string, unknown> = {}) {
  return {
    client_id: `extra-test-${Math.random().toString(36).slice(2, 10)}`,
    part: firstSlot.label,
    mode: "gym",
    status: "doing",
    started_at: new Date().toISOString(),
    template_id: firstSlot.templateId,
    extra: true,
    ...overrides,
  };
}

beforeAll(async () => {
  // 首次访问即触发建库 + 种子（与生产同一条路径）
  const { GET } = await routes.today();
  expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
  slots = await activeSlots();
  restSlot = slots.find((s) => s.rest) as SlotView;
  firstSlot = slots.find((s) => !s.rest) as SlotView;
  expect(restSlot).toBeTruthy();
  expect(firstSlot).toBeTruthy();
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

describe("加练的入口校验（13.17）", () => {
  it("今天是训练日 → 400（直接开练就行，加练只用在休息日 / 假期）", async () => {
    await anchorToday(firstSlot.position);
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody()));
    expect(res.status).toBe(400);
    expect(await pointCount()).toBe(0);
  });

  it("选了一个「休」槽位 → 400", async () => {
    await anchorToday(restSlot.position);
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody({ template_id: restSlot.templateId })));
    expect(res.status).toBe(400);
  });

  it("补录（status=done）不能是加练 → 400", async () => {
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody({ status: "done", started_at: null })));
    expect(res.status).toBe(400);
  });

  it("不是今天 → 400（过去那天真练了只是记录，不许回头改写排期）", async () => {
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody({ date: addDays(today, -1) })));
    expect(res.status).toBe(400);
    expect(await pointCount()).toBe(0);
  });
});

describe("加练落库：休息顺延 + 下一次排期去掉（13.17）", () => {
  let sessionId = 0;
  let clientId = "";
  const pastBefore = new Map<DateStr, string>();

  it("休日加练「首位槽位」：写两条位点，明天「休」、后天从加练部位的下一位接着排", async () => {
    await anchorToday(restSlot.position);
    for (let i = 1; i <= 3; i++) pastBefore.set(addDays(today, -i), await scheduleOn(addDays(today, -i)));

    const body = extraBody();
    clientId = String(body.client_id);
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", body));
    expect(res.status).toBe(201);
    const payload = await jsonOf<{ id: number; created: boolean; extra: boolean }>(res);
    expect(payload.created).toBe(true);
    expect(payload.extra).toBe(true);
    sessionId = payload.id;

    const rows = await sessionRows();
    expect(rows).toEqual([{ id: sessionId, is_extra: 1, status: "doing" }]);
    expect(await pointCount()).toBe(2);

    const succ = slots[(firstSlot.position + 1) % slots.length];
    expect(await scheduleOn(addDays(today, 1))).toBe(restSlot.label);
    expect(await scheduleOn(addDays(today, 2))).toBe(succ.label);
    expect(await scheduleOn(addDays(today, 3))).toBe(slots[(firstSlot.position + 2) % slots.length].label);

    // 加练不是顺延：不写 skip_day、不产生欠账（13.8 / 13.17）
    expect(await skipCount()).toBe(0);

    // 过去几天的排期一个字都不改（位点只影响当日及以后）
    for (const [date, part] of pastBefore) expect(await scheduleOn(date)).toBe(part);
  });

  it("今天页给出「休息顺延到哪天 + 接下来练什么」", async () => {
    const { GET } = await routes.today();
    const payload = await jsonOf<{
      session: { isExtra?: boolean } | null;
      extraShift?: { restDate: string | null; nextTraining: { date: string; part: string } | null } | null;
      dayTypes?: Record<string, string>;
    }>(await GET(req("GET", "/api/v1/today")));
    expect(payload.session?.isExtra).toBe(true);
    const succ = slots[(firstSlot.position + 1) % slots.length];
    expect(payload.extraShift?.restDate).toBe(addDays(today, 1));
    expect(payload.extraShift?.nextTraining).toEqual({ date: addDays(today, 2), part: succ.label });
    // 今天仍是「休」：加练不占循环位（13.17）
    expect(payload.dayTypes?.[today]).toBe("rest");
  });

  it("同一 client_id 重复提交：不新建、位点也不写第二条（第 7 章的「可安全重试」）", async () => {
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody({ client_id: clientId })));
    expect(res.status).toBe(200);
    const payload = await jsonOf<{ id: number; created: boolean }>(res);
    expect(payload.created).toBe(false);
    expect(payload.id).toBe(sessionId);
    expect(await pointCount()).toBe(2);
    expect((await sessionRows()).length).toBe(1);
  });

  it("置 aborted（不算练完，13.4）→ 位点一起撤，排期回原样", async () => {
    const { PATCH } = await routes.session();
    const res = await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}`, { status: "aborted" }), params({ id: String(sessionId) }));
    expect(res.status).toBe(200);
    expect(await pointCount()).toBe(0);
    expect(await scheduleOn(addDays(today, 1))).toBe(slots[(restSlot.position + 1) % slots.length].label);
  });

  it("planned 的加练不开练就不动排期；删掉也干净", async () => {
    const { POST } = await routes.sessions();
    const res = await POST(req("POST", "/api/v1/sessions", extraBody({ status: "planned" })));
    expect(res.status).toBe(201);
    const payload = await jsonOf<{ id: number }>(res);
    expect(await pointCount()).toBe(0);

    const { DELETE } = await routes.session();
    const del = await DELETE(req("DELETE", `/api/v1/sessions/${payload.id}`), params({ id: String(payload.id) }));
    expect(del.status).toBe(200);
    expect(await pointCount()).toBe(0);
  });
});

describe("顺延只发生在训练日（13.8）", () => {
  it("休息日调「今天不练」→ 400（那天本来就不练，白记一笔欠账）", async () => {
    await anchorToday(restSlot.position);
    const { POST } = await routes.skip();
    const res = await POST(req("POST", "/api/v1/skip", { date: today, reason: "missed" }));
    expect(res.status).toBe(400);
    expect(await skipCount()).toBe(0);
  });

  it("训练日照常能顺延（接口没被挡过头）", async () => {
    await anchorToday(firstSlot.position);
    const { POST } = await routes.skip();
    const res = await POST(req("POST", "/api/v1/skip", { date: today, reason: "missed" }));
    expect([200, 201]).toContain(res.status);
    expect(await skipCount()).toBe(1);
  });
});

describe("休日加班只作记录（13.11 / v1.20）", () => {
  it("加班记录与今天 / 明天的日子类型都带上 `day_type`", async () => {
    await anchorToday(restSlot.position);
    const { POST, GET } = await routes.overtime();
    expect((await POST(req("POST", "/api/v1/overtime", { date: today, start: "20:00" }))).status).toBe(201);

    const payload = await jsonOf<{
      overtimes: { date: string; dayType: string }[];
      dayTypes: Record<string, string>;
    }>(await GET(req("GET", "/api/v1/overtime?limit=30")));
    expect(payload.overtimes.find((o) => o.date === today)?.dayType).toBe("rest");
    expect(payload.dayTypes[today]).toBe("rest");
  });

  it("休日 + 加班：训练提醒照 13.10 第 4 条静默（加班不会把它变成「该顺延」）", async () => {
    const { decideReminder } = await import("@/lib/reminder/decide");
    const decision = decideReminder({
      date: today,
      partLabel: firstSlot.label,
      nextPartLabel: firstSlot.label,
      holidayName: null,
      isRestSlot: true,
      skipped: false,
      hasTrainingRecord: false,
      hasWorkoutCheckin: false,
      overtimeStart: "20:00",
      remindersEnabled: true,
      checkTime: "22:30",
      at: "22:30",
    });
    expect(decision.verdict).toBe("silent");
    expect(decision.reason).toBe("rest");
  });
});
