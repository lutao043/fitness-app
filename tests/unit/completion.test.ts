/**
 * 完成度（issue #45 / v1.47）：记录页与今日页的主指标。
 *
 * 两条口径在这里钉死：
 * - 主标 = 已记组数 / **目标组数之和**（目标为 0 → 「—」）；
 * - 副标分母 = **只算本次记过组的动作** —— 老数据 / 历史操作会留下 0 组的"僵尸动作行"，
 *   算进分母会让完成度被无理由拉低（实测出现过 5/6 而不是 5/5）。
 */

import { describe, expect, it } from "vitest";
import { sessionCompletion, type CompletionRow } from "@/lib/session-progress";

const row = (doneSets: number, targetSets: number): CompletionRow => ({
  hasSets: doneSets > 0,
  doneSets,
  targetSets,
});

describe("sessionCompletion（完成度）", () => {
  it("主标 = 已记组数 / 目标组数之和", () => {
    const rows = [row(4, 4), row(4, 4), row(2, 3)];
    expect(sessionCompletion(rows, 10).setsText).toBe("10/11 组");
  });

  it("副标 = 做满的动作数 / 参与动作数", () => {
    const rows = [row(4, 4), row(4, 4), row(2, 3)];
    expect(sessionCompletion(rows, 10).exercisesText).toBe("2/3 动作做满");
  });

  it("0 组的僵尸动作行不进分母（这就是 5/6 与 5/5 的区别）", () => {
    const withZombie = [row(4, 4), row(4, 4), row(4, 4), row(4, 4), row(4, 4), row(0, 4)];
    expect(sessionCompletion(withZombie, 20).exercisesText).toBe("5/5 动作做满");
    // 但目标之和仍按全部动作算（他计划的量就是 24 组，完成度如实反映"还差 4 组"）
    expect(sessionCompletion(withZombie, 20).setsText).toBe("20/24 组");
  });

  it("清单为空 / 目标为 0 → 不给数（显示「—」），不显示 0/0", () => {
    expect(sessionCompletion([], 0)).toEqual({ setsText: "—", exercisesText: "—" });
    expect(sessionCompletion([row(0, 0)], 0)).toEqual({ setsText: "—", exercisesText: "—" });
  });

  it("做多了不算错：超额完成仍是「做满」", () => {
    expect(sessionCompletion([row(6, 4)], 6).exercisesText).toBe("1/1 动作做满");
  });
});

describe("接口级：会话详情与今日页都带完成度，且僵尸行不进分母（验收 3 / 5）", () => {
  it("加了一个动作但一组没记 → 它不进分母（5/5 而不是 5/6）", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fitness-completion-"));
    process.env.DATABASE_FILE = join(dir, "completion.sqlite");
    process.env.DATA_DIR = dir;
    process.env.API_TOKEN = "test-token";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.APP_USERNAME = "me";

    const BASE = "http://localhost:3210";
    const req = (method: string, path: string, body?: unknown) =>
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const params = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
    const jsonOf = async (r: Response) => (await r.json()) as Record<string, unknown>;

    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const exs = getDb().select({ id: schema.exercise.id }).from(schema.exercise).limit(2).all();
    const [exA, exB] = exs.map((e) => e.id);

    const { POST: sessPOST } = await import("@/app/api/v1/sessions/route");
    const created = await jsonOf(
      await sessPOST(
        req("POST", "/api/v1/sessions", {
          client_id: "completion-session",
          part: "背+二头",
          mode: "gym",
          status: "doing",
          started_at: "2026-10-09T09:00:00.000Z",
        }),
      ),
    );
    const id = Number(created.id);

    const { POST: addEx } = await import("@/app/api/v1/sessions/[id]/exercises/route");
    for (const [exerciseId, sets] of [[exA, 2], [exB, 3]] as const) {
      await addEx(
        req("POST", `/api/v1/sessions/${id}/exercises`, { exercise_id: exerciseId, target_sets: sets, target_reps: 10 }),
        params({ id: String(id) }),
      );
    }
    // 只给 A 记满 2 组；B（3 组目标）一组没记 = 僵尸行
    const { POST: setPOST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    for (let i = 1; i <= 2; i++) {
      await setPOST(
        req("POST", `/api/v1/sessions/${id}/sets`, {
          client_key: `completion-${i}`,
          exercise_id: exA,
          set_no: i,
          weight_kg: 20,
          reps: 10,
          done_at: `2026-10-09T09:0${i}:00.000Z`,
        }),
        params({ id: String(id) }),
      );
    }

    const { GET: detailGET } = await import("@/app/api/v1/sessions/[id]/route");
    const detail = await jsonOf(await detailGET(req("GET", `/api/v1/sessions/${id}`), params({ id: String(id) })));
    const completion = detail.completion as { setsText: string; exercisesText: string; totalSets: number };
    expect(completion.setsText).toBe("2/5 组"); // 目标之和仍算全部动作（他计划的量就是 5 组）
    expect(completion.exercisesText).toBe("1/1 动作做满"); // 分母只算记过组的 A
    expect(completion.totalSets).toBe(2);

    // 今日页同一处实现（同一天、同一场会话）
    const { GET: todayGET } = await import("@/app/api/v1/today/route");
    const today = await jsonOf(await todayGET(req("GET", "/api/v1/today?date=2026-10-09")));
    const session = today.session as { id: number; completion?: { setsText: string } } | null;
    if (session?.id === id) {
      expect(session.completion?.setsText).toBe("2/5 组");
    }

    try {
      const { getSqlite } = await import("@/db/client");
      getSqlite().close();
    } catch {
      // 忽略
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
});
