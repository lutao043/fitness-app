/**
 * 内置动作库补齐（v1.22，FR-21 的补充入口）的接口级测试。
 *
 * 口径：种子只注入一次（13.12），库扩充后已装过的设备靠 `POST /api/v1/exercises/sync` 补；
 * **只新增、不修改、不删除**（按名字比对）、幂等；改过名的动作会被当成缺失再补一份（已知边界）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-exsync-"));
process.env.DATABASE_FILE = join(dir, "exsync.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

function req(method: string, path: string, body?: unknown, withAuth = true) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: withAuth
      ? { "content-type": "application/json", authorization: "Bearer test-token" }
      : { "content-type": "application/json" },
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
  exercises: async () => (await import("@/app/api/v1/exercises/route")) as { GET: Handler },
  exercise: async () => (await import("@/app/api/v1/exercises/[id]/route")) as { PATCH: Handler; DELETE: Handler },
  sync: async () => (await import("@/app/api/v1/exercises/sync/route")) as { GET: Handler; POST: Handler },
};

interface SyncPreview {
  total: number;
  missing: string[];
}
interface SyncResult {
  added: string[];
  kept: number;
  total: number;
  missing: string[];
}

async function preview(): Promise<SyncPreview> {
  const { GET } = await routes.sync();
  return jsonOf<SyncPreview>(await GET(req("GET", "/api/v1/exercises/sync")));
}
async function applySync(): Promise<SyncResult> {
  const { POST } = await routes.sync();
  return jsonOf<SyncResult>(await POST(req("POST", "/api/v1/exercises/sync")));
}
async function libraryNames(): Promise<string[]> {
  const { GET } = await routes.exercises();
  const body = await jsonOf<{ exercises: { name: string; setCount: number }[] }>(
    await GET(req("GET", "/api/v1/exercises")),
  );
  return body.exercises.map((e) => e.name);
}
async function findId(name: string): Promise<number> {
  const { getSqlite } = await import("@/db/client");
  const row = getSqlite().prepare("select id from exercise where name = ?").get(name) as { id: number } | undefined;
  if (!row) throw new Error(`动作库里没有 ${name}`);
  return row.id;
}
async function removeExercise(name: string): Promise<void> {
  const { getSqlite } = await import("@/db/client");
  const id = await findId(name);
  const sqlite = getSqlite();
  sqlite.prepare("delete from exercise_variant where exercise_id = ?").run(id);
  sqlite.prepare("delete from exercise where id = ?").run(id);
}

beforeAll(async () => {
  await libraryNames(); // 首次访问即触发建库 + 种子
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

describe("内置动作库补齐（v1.22）", () => {
  it("全新安装：内置动作全都在库里，没有可补的", async () => {
    const { EXERCISES } = await import("@/data");
    const p = await preview();
    expect(p.total).toBe(EXERCISES.length);
    expect(p.missing).toEqual([]);
    expect(await libraryNames()).toHaveLength(EXERCISES.length);
  });

  it("删掉两个动作后，预览按种子顺序列出缺的（含带器械变体的那个）", async () => {
    await removeExercise("鸟狗式");
    await removeExercise("直立划船");
    const p = await preview();
    expect(p.missing).toEqual(["直立划船", "鸟狗式"]); // 种子里的顺序：直立划船在前
  });

  it("补齐：只新增这两个，带器械变体的一起回来；幂等（再补一次 = 0）", async () => {
    const res = await applySync();
    expect(res.added).toEqual(["直立划船", "鸟狗式"]);
    expect(res.missing).toEqual([]);

    // 变体跟着回来（直立划船种子带一个哑铃变体）
    const { getSqlite } = await import("@/db/client");
    const variants = getSqlite()
      .prepare("select count(*) as c from exercise_variant where exercise_id = ?")
      .get(await findId("直立划船")) as { c: number };
    expect(variants.c).toBe(1);

    const again = await applySync();
    expect(again.added).toEqual([]);
    expect(again.total).toBe(res.total);
  });

  it("只新增不动已有：改过名 / 改过参数的动作原样保留（内置名会被补一份，界面上能看见）", async () => {
    const { PATCH } = await routes.exercise();
    const id = await findId("绳索弯举");
    const patched = await PATCH(
      req("PATCH", `/api/v1/exercises/${id}`, { name: "绳索弯举（我改的）", reps: 15 }),
      params({ id: String(id) }),
    );
    expect(patched.status).toBe(200);

    const { getSqlite } = await import("@/db/client");
    const before = (getSqlite().prepare("select count(*) as c from exercise_variant").get() as { c: number }).c;

    const res = await applySync();
    expect(res.added).toEqual(["绳索弯举"]); // 内置名缺失 → 按名字补一份（已知边界）

    // 改名那份与它的参数一个字没动
    const renamed = getSqlite()
      .prepare("select name, default_reps as reps from exercise where id = ?")
      .get(id) as { name: string; reps: number };
    expect(renamed).toEqual({ name: "绳索弯举（我改的）", reps: 15 });
    // 已有动作的变体没被追补（只补整条动作）
    const after = (getSqlite().prepare("select count(*) as c from exercise_variant").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("未认证 → 401", async () => {
    const { GET } = await routes.sync();
    expect((await GET(req("GET", "/api/v1/exercises/sync", undefined, false))).status).toBe(401);
  });
});
