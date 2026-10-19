/**
 * v1.49（issue #70）：**日期态驱动的提醒行为** —— 接口级 + 滴答级用例（临时库 + 真实路由处理器）。
 *
 * 覆盖：
 * - 设置项 `reminderTimeRestday`：默认 22:30（= 分档前行为）、读写往返、非法值 400；
 * - 补剂 `dayKind`：默认 daily、白名单校验（非法 400 不落库）、PATCH 往返；
 * - `runReminderTick` 按**当日期生效时刻**生成训练提醒（周末走休息日档、工作日 / 调休走工作日档）；
 * - 补剂适用日：仅工作日 / 仅休息日在四种日期态下的"提 / 不提"；
 * - `GET /api/v1/reminders/preview`：四种日期态的 `dateKind` 与生效时刻；
 *   已存在的法定节假日与循环位「休」仍按 13.10 第 3 / 4 条静默（分档不改判定表顺序）。
 *
 * 2026 年的四个现成样本（issue #70 §五）：10-10 调休上班日 / 10-11 周末 / 10-12 工作日 / 10-01 法定节假日。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-daykind-api-"));
process.env.DATABASE_FILE = join(dir, "daykind-api.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  settings: async () => (await import("@/app/api/v1/settings/route")) as { GET: Handler; PATCH: Handler },
  supplements: async () => (await import("@/app/api/v1/supplements/route")) as { GET: Handler; POST: Handler },
  supplement: async () => (await import("@/app/api/v1/supplements/[id]/route")) as { PATCH: Handler },
  preview: async () => (await import("@/app/api/v1/reminders/preview/route")) as { GET: Handler },
};

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
function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

/** 某个日期态样本那天的 20:05 / 22:35（本地钟点，都按 Asia/Shanghai 写死；tick 用时间戳驱动） */
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+08:00`);

let db: import("@/db/client").Db;
let eventExists: typeof import("@/db/queries").reminderEventExists;
let tickFn: typeof import("@/server/reminders").runReminderTick;

/** 三种适用日的补剂 id（建好后填） */
let dailyId = 0;
let workdayId = 0;
let restdayId = 0;

async function listSupplements() {
  const { GET } = await routes.supplements();
  const res = await GET(req("GET", "/api/v1/supplements"));
  return (await jsonOf<{ supplements: { id: number; name: string; dayKind: string }[] }>(res)).supplements;
}

beforeAll(async () => {
  const { getDb } = await import("@/db/client");
  const queries = await import("@/db/queries");
  const reminders = await import("@/server/reminders");
  db = getDb();
  eventExists = queries.reminderEventExists;
  tickFn = reminders.runReminderTick;
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上 WAL 文件偶尔还占着句柄，删不掉不影响结论
  }
});

describe("设置项 reminderTimeRestday（FR-40 / 13.21）", () => {
  it("默认 22:30 —— 分档上线不配置时，行为与分档前一致", async () => {
    const { GET } = await routes.settings();
    const res = await GET(req("GET", "/api/v1/settings"));
    const payload = await jsonOf<{ reminderTime: string; reminderTimeRestday: string }>(res);
    expect(payload.reminderTime).toBe("22:30");
    expect(payload.reminderTimeRestday).toBe("22:30");
  });

  it("改成 20:00 → 读回 20:00（工作日档不动）", async () => {
    const { GET, PATCH } = await routes.settings();
    const patch = await PATCH(req("PATCH", "/api/v1/settings", { reminderTimeRestday: "20:00" }));
    expect(patch.status).toBe(200);
    const payload = await jsonOf<{ reminderTime: string; reminderTimeRestday: string }>(
      await GET(req("GET", "/api/v1/settings")),
    );
    expect(payload.reminderTimeRestday).toBe("20:00");
    expect(payload.reminderTime).toBe("22:30");
  });

  it("非法值 400 且不写库（回读仍是 20:00）", async () => {
    const { GET, PATCH } = await routes.settings();
    for (const bad of ["8:5", "25:00", "abc", 123]) {
      const res = await PATCH(req("PATCH", "/api/v1/settings", { reminderTimeRestday: bad }));
      expect(res.status, String(bad)).toBe(400);
    }
    const payload = await jsonOf<{ reminderTimeRestday: string }>(await GET(req("GET", "/api/v1/settings")));
    expect(payload.reminderTimeRestday).toBe("20:00");
  });
});

describe("补剂 dayKind（FR-33 / 13.21）", () => {
  it("POST 不传 dayKind → daily（默认 = 分档前行为）；种子补剂也全是 daily", async () => {
    const { POST } = await routes.supplements();
    const res = await POST(req("POST", "/api/v1/supplements", { name: "测试·每天", times: ["20:00"] }));
    expect(res.status).toBe(201);
    dailyId = (await jsonOf<{ id: number }>(res)).id;

    const list = await listSupplements();
    expect(list.find((s) => s.id === dailyId)?.dayKind).toBe("daily");
    expect(list.every((s) => s.dayKind === "daily")).toBe(true);
  });

  it("POST 指定 workday / restday → 落库并读回", async () => {
    const { POST } = await routes.supplements();
    const w = await POST(req("POST", "/api/v1/supplements", { name: "测试·仅工作日", times: ["20:00"], dayKind: "workday" }));
    const r = await POST(req("POST", "/api/v1/supplements", { name: "测试·仅休息日", times: ["20:00"], dayKind: "restday" }));
    expect(w.status).toBe(201);
    expect(r.status).toBe(201);
    workdayId = (await jsonOf<{ id: number }>(w)).id;
    restdayId = (await jsonOf<{ id: number }>(r)).id;

    const list = await listSupplements();
    expect(list.find((s) => s.id === workdayId)?.dayKind).toBe("workday");
    expect(list.find((s) => s.id === restdayId)?.dayKind).toBe("restday");
  });

  it("非法 dayKind → 400 且不落库；PATCH 非法 → 400 保持原值", async () => {
    const { POST } = await routes.supplements();
    const { PATCH } = await routes.supplement();
    const countBefore = (await listSupplements()).length;

    const bad = await POST(req("POST", "/api/v1/supplements", { name: "测试·非法", times: ["20:00"], dayKind: "weekend" }));
    expect(bad.status).toBe(400);
    expect((await listSupplements()).length).toBe(countBefore);

    const badPatch = await PATCH(
      req("PATCH", `/api/v1/supplements/${workdayId}`, { dayKind: "节假日" }),
      params({ id: String(workdayId) }),
    );
    expect(badPatch.status).toBe(400);
    const list = await listSupplements();
    expect(list.find((s) => s.id === workdayId)?.dayKind).toBe("workday");
  });

  it("PATCH dayKind 往返（workday → restday → workday）", async () => {
    const { PATCH } = await routes.supplement();
    const res = await PATCH(
      req("PATCH", `/api/v1/supplements/${workdayId}`, { dayKind: "restday" }),
      params({ id: String(workdayId) }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf<{ dayKind: string }>(res)).dayKind).toBe("restday");
    await PATCH(req("PATCH", `/api/v1/supplements/${workdayId}`, { dayKind: "workday" }), params({ id: String(workdayId) }));
    expect((await listSupplements()).find((s) => s.id === workdayId)?.dayKind).toBe("workday");
  });
});

describe("训练提醒：按当日期生效时刻生成（13.21；两档 = 工作日 22:30 / 休息日 20:00）", () => {
  it("2026-10-11（周日·训练日）：19:55 不到休息日档 → 不生成；20:05 到点 → 生成", () => {
    tickFn(db, at("2026-10-11", "19:55"));
    expect(eventExists(db, "workout", "workout", "2026-10-11")).toBe(false);
    tickFn(db, at("2026-10-11", "20:05"));
    expect(eventExists(db, "workout", "workout", "2026-10-11")).toBe(true);
  });

  it("2026-10-13（周二·训练日）：20:05 不到工作日档 → 不生成；22:35 到点 → 生成", () => {
    tickFn(db, at("2026-10-13", "20:05"));
    expect(eventExists(db, "workout", "workout", "2026-10-13")).toBe(false);
    tickFn(db, at("2026-10-13", "22:35"));
    expect(eventExists(db, "workout", "workout", "2026-10-13")).toBe(true);
  });

  it("2026-10-12（周一·循环位「休」）：就算过了两个档口也不生成（第 4 条不变）", () => {
    tickFn(db, at("2026-10-12", "22:35"));
    expect(eventExists(db, "workout", "workout", "2026-10-12")).toBe(false);
  });

  it("2026-10-01（法定节假日）：静默（第 3 条不变，分档不改 8 条顺序）", () => {
    tickFn(db, at("2026-10-01", "20:05"));
    tickFn(db, at("2026-10-01", "22:35"));
    expect(eventExists(db, "workout", "workout", "2026-10-01")).toBe(false);
  });
});

describe("补剂适用日：四种日期态下的提 / 不提（13.10 第 2 条并列分支）", () => {
  const suppKey = (id: number) => `supp:${id}`;

  it("2026-10-11（周末 20:05）：daily 提、仅工作日不提、仅休息日提", () => {
    tickFn(db, at("2026-10-11", "20:05"));
    expect(eventExists(db, "supplement", suppKey(dailyId), "2026-10-11")).toBe(true);
    expect(eventExists(db, "supplement", suppKey(workdayId), "2026-10-11")).toBe(false);
    expect(eventExists(db, "supplement", suppKey(restdayId), "2026-10-11")).toBe(true);
  });

  it("2026-10-10（调休上班日 20:05）：仅工作日**照发**（调休按工作日档）", () => {
    tickFn(db, at("2026-10-10", "20:05"));
    expect(eventExists(db, "supplement", suppKey(workdayId), "2026-10-10")).toBe(true);
    expect(eventExists(db, "supplement", suppKey(restdayId), "2026-10-10")).toBe(false);
  });

  it("2026-10-13（工作日 20:05）：仅工作日提、仅休息日不提", () => {
    tickFn(db, at("2026-10-13", "20:05"));
    expect(eventExists(db, "supplement", suppKey(workdayId), "2026-10-13")).toBe(true);
    expect(eventExists(db, "supplement", suppKey(restdayId), "2026-10-13")).toBe(false);
  });

  it("2026-10-01（法定节假日 20:05）：仅工作日不提、仅休息日提（节假日属于休息日类）", () => {
    tickFn(db, at("2026-10-01", "20:05"));
    expect(eventExists(db, "supplement", suppKey(workdayId), "2026-10-01")).toBe(false);
    expect(eventExists(db, "supplement", suppKey(restdayId), "2026-10-01")).toBe(true);
  });
});

describe("演练接口：dateKind 与生效时刻（FR-55 / 13.21）", () => {
  async function preview(date: string) {
    const { GET } = await routes.preview();
    const res = await GET(req("GET", `/api/v1/reminders/preview?date=${date}`));
    expect(res.status).toBe(200);
    return jsonOf<{
      dateKind: string;
      checkTime: string;
      reminderTime: string;
      reminderTimeRestday: string;
      supplements: { id: number; appliesToday: boolean; verdict: { reason: string } }[];
    }>(res);
  }

  it("四种日期态的 dateKind 与生效时刻（10-10 makeup / 10-11 weekend / 10-12 workday / 10-01 holiday）", async () => {
    const makeup = await preview("2026-10-10");
    expect(makeup.dateKind).toBe("makeup");
    expect(makeup.checkTime).toBe("22:30"); // 调休 → 工作日档

    const weekend = await preview("2026-10-11");
    expect(weekend.dateKind).toBe("weekend");
    expect(weekend.checkTime).toBe("20:00"); // 休息日档

    const workday = await preview("2026-10-12");
    expect(workday.dateKind).toBe("workday");
    expect(workday.checkTime).toBe("22:30");

    const holiday = await preview("2026-10-01");
    expect(holiday.dateKind).toBe("holiday");
    expect(holiday.checkTime).toBe("20:00"); // 休息日档（训练提醒仍静默，见上）
  });

  it("两档原值都透出（页面显示「今天是哪种态 · 用哪档」）", async () => {
    const p = await preview("2026-10-12");
    expect(p.reminderTime).toBe("22:30");
    expect(p.reminderTimeRestday).toBe("20:00");
  });

  it("补剂 applicability 透出：周末 off_day、工作日 appliesToday=true", async () => {
    const weekend = await preview("2026-10-11");
    const weekendWorkdayOnly = weekend.supplements.find((s) => s.id === workdayId);
    expect(weekendWorkdayOnly?.appliesToday).toBe(false);
    expect(weekendWorkdayOnly?.verdict.reason).toBe("off_day");

    // 今天（2026-10-12，周一 = 工作日）—— 演练接口只收"不晚于今天"的日期
    const workday = await preview("2026-10-12");
    expect(workday.supplements.find((s) => s.id === workdayId)?.appliesToday).toBe(true);
    expect(workday.supplements.find((s) => s.id === restdayId)?.appliesToday).toBe(false);
  });
});
