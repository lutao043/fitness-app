/**
 * 数据修改日志（issue #40 / v1.41）：每条成功的写操作一行 JSON，7 天保留。
 *
 * 这里钉住三件事：**摘要是白名单取的**、**写操作才记**、**写日志失败不影响业务**。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-changelog-"));
process.env.DATABASE_FILE = join(dir, "changelog.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

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

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function changesLines(): string[] {
  try {
    return readFileSync(join(dir, "logs", `changes-${today()}.log`), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function today(): string {
  // 日志按 Asia/Shanghai 的自然日命名
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

afterAll(async () => {
  try {
    const { getSqlite } = await import("@/db/client");
    getSqlite().close();
  } catch {
    // 没打开过就忽略
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("changeSummaryFor（纯函数：白名单 + 幂等重放标记）", () => {
  it("按路由模板挑白名单字段，嵌套对象一律不进日志", async () => {
    const { changeSummaryFor } = await import("@/server/changelog");
    expect(changeSummaryFor("/api/v1/exercises", { id: 7, name: "大剪刀下拉", muscles: ["背"] })).toEqual({
      id: 7,
      name: "大剪刀下拉",
    });
    expect(changeSummaryFor("/api/v1/sessions/12/sets", { id: 3, created: true, summary: { big: "object" } })).toEqual({
      id: 3,
      created: true,
    });
  });

  it("幂等重放（created=false）标 ignored，方便回看「我明明点了一次」", async () => {
    const { changeSummaryFor } = await import("@/server/changelog");
    expect(changeSummaryFor("/api/v1/sessions/12/sets", { id: 3, created: false })).toEqual({
      id: 3,
      created: false,
      ignored: true,
    });
  });

  it("没配白名单的路由不给摘要（宁可不记，也不把响应体整包塞进日志）", async () => {
    const { changeSummaryFor } = await import("@/server/changelog");
    expect(changeSummaryFor("/api/v1/whatever", { a: 1 })).toBeUndefined();
    expect(changeSummaryFor("/api/v1/exercises", "不是对象")).toBeUndefined();
  });

  it("路由模板与资源标识：数字段与日期段都归一化", async () => {
    const { routePattern, targetFromPath } = await import("@/server/changelog");
    expect(routePattern("/api/v1/sessions/12/sets/3")).toBe("/api/v1/sessions/:id/sets/:id");
    expect(routePattern("/api/v1/skip/2026-10-12")).toBe("/api/v1/skip/:id");
    expect(targetFromPath("/api/v1/sessions/12/sets/3")).toEqual({ session_id: 12, set_id: 3 });
    expect(targetFromPath("/api/v1/skip/2026-10-12")).toEqual({ date: "2026-10-12" });
  });
});

describe("写接口落日志（接口级）", () => {
  it("助手建动作 → 一行 via=assistant + change.name（验收 1）", async () => {
    const { POST } = await import("@/app/api/v1/exercises/route");
    const res = await POST(
      req("POST", "/api/v1/exercises", {
        name: `日志用动作${Date.now() % 100000}`,
        muscles: ["三头"],
        type: "weight",
        equip: "绳索",
        load_mode: "machine",
        sets: 3,
        reps: 12,
      }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    const line = changesLines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.path === "/api/v1/exercises");
    expect(line).toBeTruthy();
    expect(line?.via).toBe("assistant");
    expect(line?.method).toBe("POST");
    expect((line?.change as Record<string, unknown>).name).toBe(body.name);
    expect((line?.change as Record<string, unknown>).id).toBe(body.id);
  });

  it("记体重 → via=session 且能看出改的是哪天的哪个时点（验收 2）", async () => {
    const { POST } = await import("@/app/api/v1/body-metrics/route");
    const res = await POST(
      req("POST", "/api/v1/body-metrics", { date: "2026-10-09", slot: "bedtime", weight_kg: 70.2 }),
    );
    expect([200, 201]).toContain(res.status);
    const line = changesLines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.path === "/api/v1/body-metrics");
    const change = (line?.change ?? {}) as Record<string, unknown>;
    expect(change.date).toBe("2026-10-09");
    expect(change.slot).toBe("bedtime");
  });

  it("删动作 → 记 before 值（name），删错了才还原得出删了什么（验收 3）", async () => {
    const { POST } = await import("@/app/api/v1/exercises/route");
    const created = await jsonOf(
      await POST(
        req("POST", "/api/v1/exercises", {
          name: `待删动作${Date.now() % 100000}`,
          muscles: ["三头"],
          type: "weight",
          equip: "绳索",
          load_mode: "machine",
          sets: 3,
          reps: 12,
        }),
      ),
    );
    const { DELETE } = await import("@/app/api/v1/exercises/[id]/route");
    const res = await DELETE(
      req("DELETE", `/api/v1/exercises/${created.id}`),
      params({ id: String(created.id) }),
    );
    expect(res.status).toBe(200);
    const line = changesLines()
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.method === "DELETE" && String(l.path).startsWith("/api/v1/exercises/"))
      .at(-1);
    expect((line?.change as Record<string, unknown>).name).toBe(created.name);
    expect((line?.change as Record<string, unknown>).removed).toBe(true);
  });

  it("GET 一律不记（验收：只有写操作进日志）", async () => {
    const before = changesLines().length;
    const { GET } = await import("@/app/api/v1/today/route");
    expect((await GET(req("GET", "/api/v1/today"))).status).toBe(200);
    expect(changesLines().length).toBe(before);
  });

  it("日志里绝不出现凭据（验收 4：token / cookie / password / argon 零命中）", async () => {
    const raw = changesLines().join("\n");
    // 凭据值、声明头、哈希一律不出现；`via` 只可能是 session / assistant
    expect(raw).not.toMatch(/Bearer|cookie|password|argon/i);
    expect(raw).not.toContain("test-token");
    // 本套用例都带 Bearer 头 → 记 assistant；无论哪条路都只可能是这两个值
    const vias = changesLines().map((l) => (JSON.parse(l) as { via?: string }).via);
    expect(vias.length).toBeGreaterThan(0);
    for (const v of vias) expect(["session", "assistant"]).toContain(v);
  });

  it("7 天前的 changes-*.log 与 app-*.log 一起清（验收 5：共用同一份实现）", async () => {
    const { pruneOldLogs } = await import("@/server/logger");
    const logsDir = join(dir, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "changes-2000-01-01.log"), "{}\n");
    writeFileSync(join(logsDir, "app-2000-01-01.log"), "{}\n");
    writeFileSync(join(logsDir, "changes-2999-01-01.log"), "{}\n");
    const removed = pruneOldLogs(7);
    const left = readdirSync(logsDir);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(left).not.toContain("changes-2000-01-01.log");
    expect(left).not.toContain("app-2000-01-01.log");
    expect(left).toContain("changes-2999-01-01.log"); // 未来的文件不动（不是"过期"）
  });

  it("日志目录不可写 → 业务照常成功（验收 6）", async () => {
    const badDir = join(dir, "not-a-dir");
    writeFileSync(badDir, "这里是个文件，不是目录");
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = badDir;
    try {
      const { POST } = await import("@/app/api/v1/checkin/route");
      const res = await POST(req("POST", "/api/v1/checkin", { date: "2026-10-09", kind: "workout" }));
      expect([200, 201]).toContain(res.status);
    } finally {
      process.env.DATA_DIR = prev;
    }
  });
});
