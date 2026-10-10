/**
 * FR-11 每组感受 · FR-4 改练其他部位 · 展示单位（§1.1）的接口级测试。
 *
 * 三件事各有"口径"要钉死：
 * 1. 感受：4 个枚举进库、**可以不标**（null），历史详情读得到（FR-11 验收标准）；
 * 2. 改练其他部位：`?part=` 换成那个槽位的清单，但**不重锚循环**（锚点、循环位都不动）；
 * 3. 单位：切 lb 只改展示层读数，**库里仍是 kg**（需求书第 12 章第 7 条）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-unit-"));
process.env.DATABASE_FILE = join(dir, "feel.sqlite");
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
  schemes: async () => (await import("@/app/api/v1/schemes/route")) as { GET: Handler },
  settings: async () => (await import("@/app/api/v1/settings/route")) as { GET: Handler; PATCH: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { GET: Handler; POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { GET: Handler; PATCH: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  set: async () => (await import("@/app/api/v1/sessions/[id]/sets/[setId]/route")) as { PATCH: Handler },
  bodyMetrics: async () => (await import("@/app/api/v1/body-metrics/route")) as { GET: Handler; POST: Handler },
  stats: async () => (await import("@/app/api/v1/stats/route")) as { GET: Handler },
};

interface SlotAdmin {
  templateId: number;
  label: string;
  rest: boolean;
  gym: { exerciseId: number }[];
}

beforeAll(async () => {
  // 首次访问即触发建库 + 种子
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

describe("FR-11 每组感受：4 个枚举进库、可以不标、历史可见", () => {
  let sessionId = 0;

  it("标了存库、没标就是 null；详情按组读得到", async () => {
    const { POST: sessPOST } = await routes.sessions();
    const sess = await sessPOST(
      req("POST", "/api/v1/sessions", {
        client_id: "feel-session-1",
        part: "背+二头",
        mode: "gym",
        status: "doing",
        started_at: "2026-09-29T13:00:00.000Z",
      }),
    );
    sessionId = Number((await jsonOf<{ id: number }>(sess)).id);

    const { getDb } = await import("@/db/client");
    const { exercise } = await import("@/db/schema");
    const exerciseId = getDb()
      .select()
      .from(exercise)
      .all()
      .find((e) => e.name === "平板卧推")!.id;

    const { POST } = await routes.sets();
    const push = (setNo: number, feel?: string) =>
      POST(
        req("POST", `/api/v1/sessions/${sessionId}/sets`, {
          client_key: `feel-set-${setNo}`,
          exercise_id: exerciseId,
          set_no: setNo,
          weight_kg: 20,
          reps: 10,
          done_at: `2026-09-29T13:0${setNo}:00.000Z`,
          ...(feel ? { feel } : {}),
        }),
        params({ id: String(sessionId) }),
      );

    for (const [index, feel] of ["easy", "normal", "hard", "failure"].entries()) {
      expect((await push(index + 1, feel)).status).toBe(201);
    }
    // 第 5 组不标：训练中不校验，留空也能过（第 12 章第 14 条）
    expect((await push(5)).status).toBe(201);

    const { GET } = await routes.session();
    const detail = await jsonOf<{ sets: { id: number; setNo: number; feel: string | null }[] }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const ordered = detail.sets.slice().sort((a, b) => a.setNo - b.setNo);
    expect(ordered.map((s) => s.feel)).toEqual(["easy", "normal", "hard", "failure", null]);
  });

  it("事后也能补标感受（PATCH 单组）", async () => {
    const { GET } = await routes.session();
    const { getDb } = await import("@/db/client");
    const { setLog } = await import("@/db/schema");
    const blank = getDb()
      .select()
      .from(setLog)
      .all()
      .find((s) => s.clientKey === "feel-set-5")!;

    const { PATCH } = await routes.set();
    const res = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}/sets/${blank.id}`, { feel: "hard" }),
      params({ id: String(sessionId), setId: String(blank.id) }),
    );
    expect(res.status).toBe(200);

    const detail = await jsonOf<{ sets: { id: number; feel: string | null }[] }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.sets.find((s) => s.id === blank.id)?.feel).toBe("hard");
  });
});

describe("FR-4 改练其他部位：?part= 只换今天的清单，不重锚循环", () => {
  it("换成另一个槽位：部位名与清单都跟着换，锚点/循环位不动", async () => {
    const { GET: todayGET } = await routes.today();
    const { GET: schemesGET } = await routes.schemes();
    const { GET: settingsGET } = await routes.settings();

    const schemes = await jsonOf<{ schemes: { id: string; slots: SlotAdmin[] }[]; activeSchemeId: string }>(
      await schemesGET(req("GET", "/api/v1/schemes")),
    );
    const active = schemes.schemes.find((s) => s.id === schemes.activeSchemeId)!;
    const trainable = active.slots.filter((s) => !s.rest);
    expect(trainable.length).toBeGreaterThan(1);

    const before = await jsonOf<{
      part: string;
      partOverride: boolean;
      isRestDay: boolean;
      scheme: { templateId: number | null; slotIndex: number; cycleLen: number };
      exercises: { exerciseId: number }[];
    }>(await todayGET(req("GET", "/api/v1/today")));
    const anchorBefore = await jsonOf<{ scheme: { anchorDate: string; anchorPosition: number } }>(
      await settingsGET(req("GET", "/api/v1/settings")),
    );

    const other = trainable.find((s) => s.label !== before.part)!;
    const after = await jsonOf<typeof before>(
      await todayGET(req("GET", `/api/v1/today?part=${other.templateId}`)),
    );

    expect(before.partOverride).toBe(false);
    expect(after.partOverride).toBe(true);
    expect(after.part).toBe(other.label);
    expect(after.scheme.templateId).toBe(other.templateId);
    expect(after.exercises.map((e) => e.exerciseId)).toEqual(other.gym.map((e) => e.exerciseId));
    // 休日也能"今天想练"：选了非休槽位就不是休息日了
    expect(after.isRestDay).toBe(false);

    // 不重锚：锚点、循环位、循环长度全是原样
    const anchorAfter = await jsonOf<{ scheme: { anchorDate: string; anchorPosition: number } }>(
      await settingsGET(req("GET", "/api/v1/settings")),
    );
    expect(anchorAfter.scheme.anchorDate).toBe(anchorBefore.scheme.anchorDate);
    expect(anchorAfter.scheme.anchorPosition).toBe(anchorBefore.scheme.anchorPosition);
    expect(after.scheme.slotIndex).toBe(before.scheme.slotIndex);
    expect(after.scheme.cycleLen).toBe(before.scheme.cycleLen);
  });

  it("非法 part 一律 400：休槽位 / 不存在的 id / 垃圾字符串", async () => {
    const { GET: todayGET } = await routes.today();
    const { GET: schemesGET } = await routes.schemes();
    const schemes = await jsonOf<{ schemes: { id: string; slots: SlotAdmin[] }[]; activeSchemeId: string }>(
      await schemesGET(req("GET", "/api/v1/schemes")),
    );
    const active = schemes.schemes.find((s) => s.id === schemes.activeSchemeId)!;
    const rest = active.slots.find((s) => s.rest);
    if (rest) {
      expect((await todayGET(req("GET", `/api/v1/today?part=${rest.templateId}`))).status).toBe(400);
    }
    expect((await todayGET(req("GET", "/api/v1/today?part=999999"))).status).toBe(400);
    expect((await todayGET(req("GET", "/api/v1/today?part=abc"))).status).toBe(400);
  });
});

describe("展示单位（§1.1）：切 lb 只改展示层，库里仍是 kg", () => {
  it("today / stats / body-metrics / 会话详情都带 unit；体重入库仍是 kg", async () => {
    const { GET: todayGET } = await routes.today();
    const { GET: settingsGET, PATCH: settingsPATCH } = await routes.settings();
    const { GET: bodyGET, POST: bodyPOST } = await routes.bodyMetrics();
    const { GET: statsGET } = await routes.stats();
    const { POST: sessPOST } = await routes.sessions();

    // 默认 kg
    expect((await jsonOf<{ unit: string }>(await todayGET(req("GET", "/api/v1/today")))).unit).toBe("kg");

    // 记一条 70 kg 的体重（界面在 lb 下会换算成 154.3 lb 展示）
    const created = await bodyPOST(
      req("POST", "/api/v1/body-metrics", { date: "2026-09-29", slot: "morning", weight_kg: 70 }),
    );
    expect([200, 201]).toContain(created.status);

    // 切 lb：所有读数单位跟着变
    const patched = await settingsPATCH(req("PATCH", "/api/v1/settings", { unit: "lb" }));
    expect(patched.status).toBe(200);
    expect((await jsonOf<{ unit: string }>(await settingsGET(req("GET", "/api/v1/settings")))).unit).toBe("lb");
    expect((await jsonOf<{ unit: string }>(await todayGET(req("GET", "/api/v1/today")))).unit).toBe("lb");
    expect((await jsonOf<{ unit: string }>(await statsGET(req("GET", "/api/v1/stats?days=30")))).unit).toBe("lb");

    const body = await jsonOf<{ unit: string; series: { date: string; slot: string; weightKg: number }[] }>(
      await bodyGET(req("GET", "/api/v1/body-metrics?limit=30")),
    );
    expect(body.unit).toBe("lb");
    // 口径：切单位不动数据 —— 库里那一行仍是 70 kg
    const row = body.series.find((r) => r.date === "2026-09-29" && r.slot === "morning");
    expect(row?.weightKg).toBe(70);

    // 会话详情也带单位（训练页的加减器按它换算）
    const sess = await sessPOST(
      req("POST", "/api/v1/sessions", {
        client_id: "unit-session-1",
        part: "胸+三头",
        mode: "gym",
        status: "doing",
        started_at: "2026-09-29T18:00:00.000Z",
      }),
    );
    const sessionId = Number((await jsonOf<{ id: number }>(sess)).id);
    const { GET: sessionGET } = await routes.session();
    const detail = await jsonOf<{ unit: string }>(
      await sessionGET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.unit).toBe("lb");

    // 恢复 kg，别把设置留给别的用例
    await settingsPATCH(req("PATCH", "/api/v1/settings", { unit: "kg" }));
    expect((await jsonOf<{ unit: string }>(await todayGET(req("GET", "/api/v1/today")))).unit).toBe("kg");
  });
});
