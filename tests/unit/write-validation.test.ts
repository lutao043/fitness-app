/**
 * v1.32（issue #14）：记录类写接口的**字段范围**表驱动用例。
 *
 * 分两层：
 * 1. **解析层**（纯函数，快）：每个字段 × {下界、上界、越界、非数字、缺省} —— 范围常量与
 *    消息都在 `src/server/rules.ts`（需求书 13.19 的「写接口字段范围表」与那里逐项对齐）；
 * 2. **接口层**（临时库）：越界 → 400 且**回读资源 = 写入前的值**（库不变）。
 *
 * 注意两个「0 的口径不同」是故意的：记一组的读数 `0` 合法（13.1），体重 `0` 非法（13.2）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseBodyAnalysisBody,
  parseBodyMetricBody,
  parseCardioBody,
  parseOvertimeBody,
  parseReanchorBody,
  parseSessionPatchBody,
  parseSetBody,
  parseSkipBody,
  type ParseResult,
} from "@/server/rules";

const TODAY = "2026-10-09";
const YESTERDAY = "2026-10-08";

/** 断言一个 parse 结果：`issuePart` 给了就要求失败且消息里含它 */
function check<T>(res: ParseResult<T>, expectOk: boolean, issuePart?: string) {
  if (expectOk) {
    expect(res.ok, `期望通过，实际失败：${res.ok ? "" : res.issues.join("；")}`).toBe(true);
    return;
  }
  expect(res.ok, "期望失败，实际通过了").toBe(false);
  if (!res.ok && issuePart) expect(res.issues.join("；")).toContain(issuePart);
}

interface Case {
  name: string;
  body: Record<string, unknown>;
  ok: boolean;
  issue?: string;
}

function table<T>(parse: (body: Record<string, unknown>) => ParseResult<T>, cases: Case[]) {
  for (const c of cases) {
    it(c.name, () => check(parse(c.body), c.ok, c.issue));
  }
}

/* ————————————————————————— 记体重（13.2） ————————————————————————— */

describe("parseBodyMetricBody（记体重 13.2）", () => {
  const parse = (body: Record<string, unknown>) => parseBodyMetricBody(body, { defaultDate: TODAY });

  table(parse, [
    { name: "weight 下界 0 → 400（0 不是一次称重）", body: { weight_kg: 0 }, ok: false, issue: "weight_kg" },
    { name: "weight 0.1 / 上界 400 收", body: { weight_kg: 400 }, ok: true },
    { name: "weight 401 越界 → 400", body: { weight_kg: 401 }, ok: false, issue: "0~400" },
    { name: 'weight "abc" 非数字 → 400', body: { weight_kg: "abc" }, ok: false, issue: "weight_kg" },
    { name: "weight 缺省 → 400", body: {}, ok: false, issue: "weight_kg" },
    { name: "body_fat 缺省 = null（选填）", body: { weight_kg: 70 }, ok: true },
    { name: "body_fat 下界 0 / 上界 75 收", body: { weight_kg: 70, body_fat_pct: 75 }, ok: true },
    { name: "body_fat -3 → 400", body: { weight_kg: 70, body_fat_pct: -3 }, ok: false, issue: "0~75" },
    { name: "body_fat 100 → 400", body: { weight_kg: 70, body_fat_pct: 100 }, ok: false, issue: "0~75" },
    { name: 'body_fat "abc"（存在但非数字）→ 400', body: { weight_kg: 70, body_fat_pct: "abc" }, ok: false, issue: "body_fat_pct" },
    { name: "body_fat null = 显式清空 → 收", body: { weight_kg: 70, body_fat_pct: null }, ok: true },
    { name: "slot 缺省 = morning；非法 slot → 400", body: { weight_kg: 70, slot: "noon" }, ok: false, issue: "slot" },
    { name: "date 坏格式 → 400", body: { weight_kg: 70, date: "2026-99-99" }, ok: false, issue: "date" },
  ]);

  it("缺省值：slot=morning、date=今天、note=null", () => {
    const res = parse({ weight_kg: 70 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.slot).toBe("morning");
      expect(res.value.date).toBe(TODAY);
      expect(res.value.note).toBeNull();
      expect(res.value.bodyFatPct).toBeNull();
    }
  });
});

/* ————————————————————————— 记一组（13.1） ————————————————————————— */

describe("parseSetBody（记一组 13.1 / FR-11）", () => {
  const parse = (body: Record<string, unknown>) =>
    parseSetBody(body, { defaultClientKey: "k1", defaultDoneAt: "2026-10-09T10:00:00+08:00" });

  table(parse, [
    { name: "weight 下界 -1 → 400", body: { exercise_id: 1, weight_kg: -1 }, ok: false, issue: "0~400" },
    { name: "weight 0 合法（试举失败，13.1）", body: { exercise_id: 1, weight_kg: 0 }, ok: true },
    { name: "weight 上界 400 收 / 401 → 400", body: { exercise_id: 1, weight_kg: 401 }, ok: false, issue: "0~400" },
    { name: 'weight "abc" → 400', body: { exercise_id: 1, weight_kg: "abc" }, ok: false, issue: "weight_kg" },
    { name: "reps 0 / 999 收，1000 → 400", body: { exercise_id: 1, reps: 1000 }, ok: false, issue: "0~999" },
    { name: "reps 12.5 非整数 → 400", body: { exercise_id: 1, reps: 12.5 }, ok: false, issue: "整数" },
    { name: "读数缺省 = null（留空合法）", body: { exercise_id: 1 }, ok: true },
    { name: "缺少 exercise_id → 400", body: { reps: 10 }, ok: false, issue: "exercise_id" },
    { name: "feel 合法枚举收 / 非法枚举 → 400", body: { exercise_id: 1, feel: "xyz" }, ok: false, issue: "feel" },
    { name: "feel null = 没标 → 收", body: { exercise_id: 1, feel: null }, ok: true },
    { name: "is_warmup: true → 400（v1.26）", body: { exercise_id: 1, is_warmup: true }, ok: false, issue: "热身" },
    { name: "is_warmup: false → 照常收", body: { exercise_id: 1, is_warmup: false }, ok: true },
  ]);
});

/* ————————————————————————— 顺延（13.8） ————————————————————————— */

describe("parseSkipBody（顺延 13.8）", () => {
  const parse = (body: Record<string, unknown>) => parseSkipBody(body, { defaultDate: TODAY });

  table(parse, [
    { name: "reason 缺省 = missed（缺省不是非法）", body: {}, ok: true },
    { name: "reason 合法枚举收", body: { reason: "overtime" }, ok: true },
    { name: 'reason "xyz" → 400', body: { reason: "xyz" }, ok: false, issue: "reason" },
    { name: "reason 123（非字符串）→ 400", body: { reason: 123 }, ok: false, issue: "reason" },
    { name: "date 坏格式 → 400", body: { date: "2026-99-99" }, ok: false, issue: "date" },
  ]);

  it("缺省 reason = missed、confirm = false", () => {
    const res = parse({});
    expect(res.ok && res.value.reason).toBe("missed");
    expect(res.ok && res.value.confirm).toBe(false);
  });
});

/* ————————————————————————— 有氧（FR-50） ————————————————————————— */

describe("parseCardioBody（有氧 FR-50）", () => {
  const parse = (body: Record<string, unknown>) =>
    parseCardioBody(body, { today: TODAY, yesterday: YESTERDAY });

  table(parse, [
    { name: "minutes 下界 0 → 400", body: { minutes: 0 }, ok: false, issue: "1~600" },
    { name: "minutes 1 / 上界 600 收", body: { minutes: 600 }, ok: true },
    { name: "minutes 601 → 400", body: { minutes: 601 }, ok: false, issue: "1~600" },
    { name: "minutes 1.5 非整数 → 400", body: { minutes: 1.5 }, ok: false, issue: "整数" },
    { name: 'minutes "abc" → 400', body: { minutes: "abc" }, ok: false, issue: "minutes" },
    { name: "minutes 缺省 → 400", body: {}, ok: false, issue: "minutes" },
    { name: "date 今天 / 昨天收", body: { minutes: 30, date: YESTERDAY }, ok: true },
    { name: "date 前天 → 400", body: { minutes: 30, date: "2026-10-07" }, ok: false, issue: "今天或昨天" },
    { name: "date 明天 → 400", body: { minutes: 30, date: "2026-10-10" }, ok: false, issue: "未来" },
    { name: "date 坏格式 → 400", body: { minutes: 30, date: "2026-99-99" }, ok: false, issue: "date" },
  ]);
});

/* ————————————————————————— 加班（FR-22） ————————————————————————— */

describe("parseOvertimeBody（加班 FR-22：POST 两栏必填 / PATCH 只校验带来的）", () => {
  const post = (body: Record<string, unknown>) => parseOvertimeBody(body, { requireAll: true, defaultDate: TODAY });
  const patch = (body: Record<string, unknown>) => parseOvertimeBody(body, { requireAll: false, defaultDate: TODAY });

  table(post, [
    { name: 'POST start "20:00" 收', body: { start: "20:00" }, ok: true },
    { name: 'POST start "25:00" → 400', body: { start: "25:00" }, ok: false, issue: "HH:mm" },
    { name: 'POST start "8:5" → 400', body: { start: "8:5" }, ok: false, issue: "HH:mm" },
    { name: "POST start 缺省 → 400", body: {}, ok: false, issue: "start" },
    { name: "POST date 坏格式 → 400", body: { start: "20:00", date: "2026-99-99" }, ok: false, issue: "date" },
  ]);

  table(patch, [
    { name: "PATCH 只带 note → 收（date / start 不动）", body: { note: "改个备注" }, ok: true },
    { name: 'PATCH start "25:00" → 400', body: { start: "25:00" }, ok: false, issue: "HH:mm" },
    { name: "PATCH date 坏格式 → 400", body: { date: "2026-99-99" }, ok: false, issue: "date" },
  ]);

  it("PATCH 不带某字段时 value 里也没有（不能把没传的覆盖成空）", () => {
    const res = patch({ note: "x" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.date).toBeUndefined();
      expect(res.value.start).toBeUndefined();
    }
  });
});

/* ————————————————————————— 重锚（FR-23） ————————————————————————— */

describe("parseReanchorBody（重锚 FR-23）", () => {
  const parse = (body: Record<string, unknown>) =>
    parseReanchorBody(body, { defaultDate: TODAY, cycleLen: 4 });

  table(parse, [
    { name: "下界 0 收 / 上界 3 收（cycleLen=4）", body: { cycle_position: 3 }, ok: true },
    { name: "负数 → 400", body: { cycle_position: -1 }, ok: false, issue: "0..3" },
    { name: "越界 4 → 400", body: { cycle_position: 4 }, ok: false, issue: "0..3" },
    { name: "小数 → 400", body: { cycle_position: 1.5 }, ok: false, issue: "整数" },
    { name: '非数字 "abc" → 400', body: { cycle_position: "abc" }, ok: false, issue: "cycle_position" },
    { name: "缺省 → 400", body: {}, ok: false, issue: "cycle_position" },
    { name: "camelCase 别名收", body: { cyclePosition: 1 }, ok: true },
  ]);
});

/* ————————————————————————— 每日体重分析（FR-57） ————————————————————————— */

describe("parseBodyAnalysisBody（每日体重分析 FR-57）", () => {
  const parse = (body: Record<string, unknown>) => parseBodyAnalysisBody(body, { defaultDate: TODAY });

  table(parse, [
    { name: "level 三个枚举都收", body: { level: "watch", text: "x" }, ok: true },
    { name: 'level "good" → 400', body: { level: "good", text: "x" }, ok: false, issue: "level" },
    { name: "level 缺省 → 400", body: { text: "x" }, ok: false, issue: "level" },
    { name: "text 下界 1 字收 / 上界 800 字收", body: { level: "normal", text: "长".repeat(800) }, ok: true },
    { name: "text 801 字 → 400", body: { level: "normal", text: "长".repeat(801) }, ok: false, issue: "800" },
    { name: "text 空串 / 全空格 → 400", body: { level: "normal", text: "   " }, ok: false, issue: "text" },
    { name: "date 坏格式 → 400", body: { level: "normal", text: "x", date: "2026-99-99" }, ok: false, issue: "date" },
  ]);
});

/* ————————————————————————— 改会话（FR-12 / FR-4） ————————————————————————— */

describe("parseSessionPatchBody（改会话：枚举不静默兜底）", () => {
  const parse = (body: Record<string, unknown>) => parseSessionPatchBody(body);

  table(parse, [
    { name: "status 合法枚举收", body: { status: "done" }, ok: true },
    { name: "status 非法 → 400（以前静默当没传）", body: { status: "finished" }, ok: false, issue: "status" },
    { name: "mode 合法收 / 非法 → 400", body: { mode: "hotel" }, ok: false, issue: "mode" },
    { name: "feel 合法收 / 非法 → 400", body: { feel: "xyz" }, ok: false, issue: "feel" },
    { name: "feel null / 空串 = 清掉 → 收", body: { feel: null }, ok: true },
    { name: "空 body → 收（PATCH 允许什么都不改）", body: {}, ok: true },
  ]);
});

/* ————————————————————————— 接口层：越界 → 400 且库不变 ————————————————————————— */

const dir = mkdtempSync(join(tmpdir(), "fitness-write-validation-"));
process.env.DATABASE_FILE = join(dir, "write-validation.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";
type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  session: async () => (await import("@/app/api/v1/sessions/[id]/route")) as { GET: Handler; PATCH: Handler },
  cardio: async () => (await import("@/app/api/v1/cardio/route")) as { GET: Handler; POST: Handler },
  overtime: async () => (await import("@/app/api/v1/overtime/route")) as { GET: Handler; POST: Handler },
  reanchor: async () => (await import("@/app/api/v1/reanchor/route")) as { POST: Handler },
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
let sessionId = 0;

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  const { GET } = await routes.today();
  expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
  const { getDb } = await import("@/db/client");
  const { exercise } = await import("@/db/schema");
  benchId = getDb().select().from(exercise).all().find((e) => e.name === "平板卧推")!.id;
  const created = await (await routes.sessions()).POST(
    req("POST", "/api/v1/sessions", {
      client_id: "wv-session",
      date: today,
      part: "胸+三头",
      mode: "gym",
      status: "doing",
      started_at: `${today}T10:00:00+08:00`,
      exercises: [{ exercise_id: benchId, target_sets: 4, target_reps: 12 }],
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

describe("接口层：越界 400 且回读 = 写入前的值（issue #14 验收 1）", () => {
  it("记一组：reps 1000 → 400，那场会话的组数不变", async () => {
    const { POST } = await routes.sets();
    const before = await jsonOf<{ sets: unknown[] }>(
      await (await routes.session()).GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "wv-bad-set",
        exercise_id: benchId,
        set_no: 1,
        weight_kg: 20,
        reps: 1000,
        done_at: `${today}T10:05:00+08:00`,
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(400);
    expect(String((await jsonOf(res)).error)).toContain("0~999");
    const after = await jsonOf<{ sets: unknown[] }>(
      await (await routes.session()).GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(after.sets.length).toBe(before.sets.length);
  });

  it("记一组：feel 非法 → 400（以前静默当没标）", async () => {
    const { POST } = await routes.sets();
    const res = await POST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "wv-bad-feel",
        exercise_id: benchId,
        set_no: 1,
        weight_kg: 20,
        reps: 12,
        feel: "so-so",
        done_at: `${today}T10:06:00+08:00`,
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(400);
    expect(String((await jsonOf(res)).error)).toContain("feel");
  });

  it("有氧：minutes 0 → 400，今天仍没有记录", async () => {
    const { POST, GET } = await routes.cardio();
    const res = await POST(req("POST", "/api/v1/cardio", { minutes: 0 }));
    expect(res.status).toBe(400);
    const list = await jsonOf<{ rows: unknown[] }>(await GET(req("GET", "/api/v1/cardio?days=14")));
    expect(list.rows).toHaveLength(0);
  });

  it("加班：start 25:00 → 400，列表仍为空", async () => {
    const { POST, GET } = await routes.overtime();
    const res = await POST(req("POST", "/api/v1/overtime", { start: "25:00" }));
    expect(res.status).toBe(400);
    const list = await jsonOf<{ rows?: unknown[] } | unknown[]>(await GET(req("GET", "/api/v1/overtime")));
    const rows = Array.isArray(list) ? list : (list.rows ?? []);
    expect(rows).toHaveLength(0);
  });

  it("重锚：cycle_position 越界 → 400，锚点链没多出记录", async () => {
    const { getSqlite } = await import("@/db/client");
    const before = (getSqlite().prepare("select count(*) as c from schedule_anchor").get() as { c: number }).c;
    const { POST } = await routes.reanchor();
    const res = await POST(req("POST", "/api/v1/reanchor", { cycle_position: 99 }));
    expect(res.status).toBe(400);
    const after = (getSqlite().prepare("select count(*) as c from schedule_anchor").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("改会话：status 非法 → 400（以前静默忽略），会话状态没变", async () => {
    const { PATCH, GET } = await routes.session();
    const res = await PATCH(req("PATCH", `/api/v1/sessions/${sessionId}`, { status: "finished" }), params({ id: String(sessionId) }));
    expect(res.status).toBe(400);
    const detail = await jsonOf<{ session: { status: string } }>(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    expect(detail.session.status).toBe("doing");
  });
});
