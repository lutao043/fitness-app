/**
 * v1.29：GET/POST /api/v1/body-analysis —— 每日体重分析（FR-57，助手写入、网页只读）。
 *
 * 钉住 issue #6 的验收：
 * 1. POST 新建 → 201；GET 读回日期 / 结论 / 正文一致；
 * 2. 同一 `date` 再 POST → 200 且**只有一条**（内容被覆盖）；
 * 3. `GET ?limit=7` → 按日期倒序的 ≤7 条；
 * 4. 非法输入（level 不在白名单 / 正文超长 / 日期格式错 / 空正文）→ **400 且不落库**；
 * 5. 没有任何记录时 GET 返回空数组（页面据此不渲染整块）；
 * + `source` 固定 `assistant`（调用方传什么都不认）、`date` 缺省 = 今天、limit 越界 400。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-body-analysis-"));
process.env.DATABASE_FILE = join(dir, "body-analysis.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  analysis: async () =>
    (await import("@/app/api/v1/body-analysis/route")) as { GET: Handler; POST: Handler },
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

interface Row {
  date: string;
  level: "normal" | "watch" | "suspect";
  text: string;
  source: string;
}

let today = "";

async function list(query = ""): Promise<{ limit: number; items: Row[] }> {
  const { GET } = await routes.analysis();
  const res = await GET(req("GET", `/api/v1/body-analysis${query}`));
  expect(res.status).toBe(200);
  return jsonOf<{ limit: number; items: Row[] }>(res);
}

async function countRows(): Promise<number> {
  return (await list("?limit=90")).items.length;
}

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  // 首次访问即触发建库 + 种子（与生产同一条路径）；新表由迁移 0004 建出来
  const res = await list();
  expect(res.items).toEqual([]);
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

describe("每日体重分析（FR-57）", () => {
  it("空态：还没有分析时返回空数组（页面据此不渲染整块）", async () => {
    const body = await list();
    expect(body.items).toEqual([]);
    expect(body.limit).toBe(30);
  });

  it("POST 新建 → 201；GET 读回一致；source 固定 assistant", async () => {
    const { POST } = await routes.analysis();
    const res = await POST(
      req("POST", "/api/v1/body-analysis", {
        date: "2026-10-09",
        level: "watch",
        text: "比昨天 +0.6kg：昨晚练了背、睡前称过一次；\n体脂没动，先看三天再判断。",
        // 调用方塞 source 也不认（服务端写死 assistant）
        source: "web",
      }),
    );
    expect(res.status).toBe(201);
    const created = await jsonOf<{ date: string; created: boolean; level: string }>(res);
    expect(created).toMatchObject({ date: "2026-10-09", created: true, level: "watch" });

    const items = (await list()).items;
    const row = items.find((r) => r.date === "2026-10-09")!;
    expect(row.level).toBe("watch");
    expect(row.text).toContain("体脂没动");
    expect(row.source).toBe("assistant");
  });

  it("同一天再 POST → 200 且只有一条（覆盖，幂等）", async () => {
    const { POST } = await routes.analysis();
    const res = await POST(
      req("POST", "/api/v1/body-analysis", {
        date: "2026-10-09",
        level: "normal",
        text: "重算了一遍：水分波动，正常。",
      }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf<{ created: boolean }>(res)).created).toBe(false);

    const same = (await list()).items.filter((r) => r.date === "2026-10-09");
    expect(same).toHaveLength(1);
    expect(same[0].level).toBe("normal");
    expect(same[0].text).toBe("重算了一遍：水分波动，正常。");
  });

  it("date 缺省 = 今天", async () => {
    const { POST } = await routes.analysis();
    const res = await POST(req("POST", "/api/v1/body-analysis", { level: "normal", text: "今天没称。" }));
    // 201 = 今天还没有过解读；200 = 前面某条用例已经写过今天（都是覆盖语义，别写死顺序）
    expect([200, 201]).toContain(res.status);
    expect((await jsonOf<{ date: string }>(res)).date).toBe(today);
    const row = (await list()).items.find((r) => r.date === today);
    expect(row?.text).toBe("今天没称。");
  });

  it("GET ?limit=7 → 按日期倒序的 ≤7 条", async () => {
    const { POST } = await routes.analysis();
    const time = await import("@/lib/time");
    // 相对今天取日期：写死日期会在跨零点后失效（"最新一条"变成今天那条）
    const d1 = time.addDays(today, -3);
    const d2 = time.addDays(today, -2);
    const d3 = time.addDays(today, -1);
    for (const d of [d1, d2, d3]) {
      await POST(req("POST", "/api/v1/body-analysis", { date: d, level: "normal", text: `${d} 正常` }));
    }
    const body = await list("?limit=7");
    expect(body.limit).toBe(7);
    expect(body.items.length).toBeLessThanOrEqual(7);
    const dates = body.items.map((r) => r.date);
    expect([...dates].sort((a, b) => (a < b ? 1 : -1))).toEqual(dates); // 倒序
    expect(dates[0]).toBe(today); // 最新一条 = 今天（上面「date 缺省 = 今天」写的那条）
  });

  it("非法输入 → 400 且不落库（level 白名单 / 正文超长 / 空正文 / 日期格式）", async () => {
    const { POST } = await routes.analysis();
    const before = await countRows();

    const cases: { body: unknown; contains: string }[] = [
      { body: { date: "2026-10-05", level: "good", text: "x" }, contains: "level" },
      { body: { date: "2026-10-05", level: "normal", text: "" }, contains: "text" },
      { body: { date: "2026-10-05", level: "normal", text: "   " }, contains: "text" },
      { body: { date: "2026-10-05", level: "normal", text: "长".repeat(801) }, contains: "800" },
      { body: { date: "2026-99-99", level: "normal", text: "x" }, contains: "date" },
      { body: { date: "2026-10-05", level: 123, text: "x" }, contains: "level" },
    ];
    for (const c of cases) {
      const res = await POST(req("POST", "/api/v1/body-analysis", c.body));
      expect(res.status).toBe(400);
      expect(String((await jsonOf(res)).error)).toContain(c.contains);
    }
    expect(await countRows()).toBe(before);
    // 恰好 800 字收（边界另一侧）
    const ok = await POST(
      req("POST", "/api/v1/body-analysis", { date: "2026-10-05", level: "normal", text: "长".repeat(800) }),
    );
    expect(ok.status).toBe(201);
  });

  it("GET limit 越界 → 400", async () => {
    const { GET } = await routes.analysis();
    for (const bad of ["0", "91", "-1", "abc", "2.5"]) {
      expect((await GET(req("GET", `/api/v1/body-analysis?limit=${bad}`))).status).toBe(400);
    }
  });

  it("未认证 → 401（与其余 /api/v1 一致）", async () => {
    const { GET } = await routes.analysis();
    const res = await GET(new Request(`${BASE}/api/v1/body-analysis`));
    expect(res.status).toBe(401);
  });
});
