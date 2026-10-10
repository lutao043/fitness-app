/**
 * 训练时长（13.3 v1.34 / issue #38）。
 *
 * 口径：**墙上时间 = ended_at − started_at，含组间歇的暂停**（与 FR-42 / 13.5 的
 * 「组间歇扣暂停」不是一回事）；两个时间戳缺一 → null，读侧显示「—」，不许当 0。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { durationMinutesText, sessionDurationSec } from "@/lib/caliber";

const dir = mkdtempSync(join(tmpdir(), "fitness-duration-"));
process.env.DATABASE_FILE = join(dir, "duration.sqlite");
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

afterAll(async () => {
  try {
    const { getSqlite } = await import("@/db/client");
    getSqlite().close();
  } catch {
    // 没打开过就忽略
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("sessionDurationSec（纯函数）", () => {
  it("正常：两个时间戳相减，取秒", () => {
    expect(sessionDurationSec("2026-10-09T12:36:00.000Z", "2026-10-09T13:27:00.000Z")).toBe(3060);
    expect(sessionDurationSec("2026-10-09T12:36:00.000Z", "2026-10-09T12:36:01.400Z")).toBe(1);
  });

  it("缺一个时间戳 → null（不许拿「现在」倒推、也不许当 0）", () => {
    expect(sessionDurationSec(null, "2026-10-09T13:27:00.000Z")).toBeNull();
    expect(sessionDurationSec("2026-10-09T12:36:00.000Z", null)).toBeNull();
    expect(sessionDurationSec(undefined, undefined)).toBeNull();
    expect(sessionDurationSec("", "")).toBeNull();
  });

  it("坏值 → null", () => {
    expect(sessionDurationSec("昨天", "2026-10-09T13:27:00.000Z")).toBeNull();
    expect(sessionDurationSec("2026-10-09T12:36:00.000Z", "abc")).toBeNull();
  });

  it("跨零点按两个时间戳相减，不按自然日切分（13.3）", () => {
    // 23:40 开练 → 次日 00:20 收工 = 40 分钟
    expect(sessionDurationSec("2026-10-09T15:40:00.000Z", "2026-10-09T16:20:00.000Z")).toBe(2400);
  });

  it("ended 早于 started（时钟回拨）按 0 算，不给负数", () => {
    expect(sessionDurationSec("2026-10-09T13:00:00.000Z", "2026-10-09T12:00:00.000Z")).toBe(0);
  });

  it("文案：拿不到给「—」，不显示 0 分钟（issue #38 验收 3）", () => {
    expect(durationMinutesText(null)).toBe("—");
    expect(durationMinutesText(undefined)).toBe("—");
    expect(durationMinutesText(3060)).toBe("51 分钟");
    expect(durationMinutesText(0)).toBe("0 分钟"); // 真的是 0 秒（点开就收工）照实显示
  });
});

describe("小结里的时长（接口级）", () => {
  let sessionId = 0;
  let exerciseId = 0;

  beforeAll(async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    exerciseId = Number(
      getDb().select({ id: schema.exercise.id }).from(schema.exercise).limit(1).get()?.id ?? 0,
    );
    expect(exerciseId).toBeGreaterThan(0);

    const { POST } = await import("@/app/api/v1/sessions/route");
    const res = await POST(
      req("POST", "/api/v1/sessions", {
        client_id: "duration-session-1",
        part: "背+二头",
        mode: "gym",
        status: "doing",
        started_at: "2026-10-09T04:36:00.000Z",
      }),
    );
    expect(res.status).toBe(201);
    sessionId = Number((await jsonOf(res)).id);

    const { POST: setPOST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const setRes = await setPOST(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: "duration-set-1",
        exercise_id: exerciseId,
        set_no: 1,
        weight_kg: 20,
        reps: 12,
        done_at: "2026-10-09T04:40:00.000Z",
      }),
      params({ id: String(sessionId) }),
    );
    expect(setRes.status).toBe(201);
  });

  it("收工：时长 = 墙上时间（含 paused_sec 那 10 分钟，不再扣）", async () => {
    const { PATCH } = await import("@/app/api/v1/sessions/[id]/route");
    const res = await PATCH(
      req("PATCH", `/api/v1/sessions/${sessionId}`, {
        status: "done",
        ended_at: "2026-10-09T06:06:00.000Z", // 12:36 开练 → 14:06 收工 = 90 分钟
        paused_sec: 600, // 组间歇里按过 10 分钟暂停：旧口径会算成 80 分钟
      }),
      params({ id: String(sessionId) }),
    );
    expect(res.status).toBe(200);
    const summary = (await jsonOf(res)).summary as { durationSec: number | null; minutes: number };
    expect(summary.durationSec).toBe(5400);
    expect(summary.minutes).toBe(90);
  });

  it("会话详情与今日卡读到的也是同一份（durationSec 落库）", async () => {
    const { GET } = await import("@/app/api/v1/sessions/[id]/route");
    const detail = await jsonOf(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const summary = detail.summary as { durationSec: number | null; minutes: number };
    expect(summary.durationSec).toBe(5400);
    expect(summary.minutes).toBe(90);
  });

  it("存量小结（本版之前落的、没有 durationSec 且 minutes 扣过暂停）读侧按新口径补齐", async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { normalizeSummary } = await import("@/server/session");

    getDb()
      .update(schema.workoutSession)
      .set({ summary: { totalSets: 1, volumeKg: 240, minutes: 80, avgRestSec: 0, avgChangeoverSec: 0, sameRestSets: 0, changeoverSets: 0 } })
      .where(eq(schema.workoutSession.id, sessionId))
      .run();

    const { GET } = await import("@/app/api/v1/sessions/[id]/route");
    const detail = await jsonOf(
      await GET(req("GET", `/api/v1/sessions/${sessionId}`), params({ id: String(sessionId) })),
    );
    const summary = detail.summary as { durationSec: number | null; minutes: number; volumeKg: number };
    expect(summary.durationSec).toBe(5400);
    expect(summary.minutes).toBe(90);
    expect(summary.volumeKg).toBe(240); // 其余字段原样

    // 纯函数层面同样成立：没有 durationSec 键才补，有（哪怕是 null）就不动
    expect(normalizeSummary({ minutes: 80 }, { startedAt: null, endedAt: null })).toMatchObject({
      durationSec: null,
      minutes: 0,
    });
    expect(
      normalizeSummary({ durationSec: 60, minutes: 1 }, { startedAt: null, endedAt: null }),
    ).toMatchObject({ durationSec: 60, minutes: 1 });
  });

  it("补录（status=done 且没有 started_at）：时长 null / 0 分钟，不编时间", async () => {
    const { POST } = await import("@/app/api/v1/sessions/route");
    const res = await POST(
      req("POST", "/api/v1/sessions", {
        client_id: "duration-backfill-1",
        part: "胸+三头",
        mode: "gym",
        status: "done",
      }),
    );
    expect(res.status).toBe(201);
    const summary = (await jsonOf(res)).summary as { durationSec: number | null; minutes: number };
    expect(summary.durationSec).toBeNull();
    expect(summary.minutes).toBe(0);
  });

  it("孤儿会话置 aborted：ended_at 取最后一组 done_at；一组都没有则留 null", async () => {
    const { getDb } = await import("@/db/client");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { abortOrphanSessions } = await import("@/db/writes");
    const { POST } = await import("@/app/api/v1/sessions/route");

    // 30 小时前开练的两场：一场记了一组、一场什么都没记
    const startedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const withSet = Number(
      (await jsonOf(
        await POST(
          req("POST", "/api/v1/sessions", {
            client_id: "duration-orphan-1",
            part: "腿",
            mode: "gym",
            status: "doing",
            started_at: startedAt,
          }),
        ),
      )).id,
    );
    const noSet = Number(
      (await jsonOf(
        await POST(
          req("POST", "/api/v1/sessions", {
            client_id: "duration-orphan-2",
            part: "腿",
            mode: "gym",
            status: "doing",
            started_at: startedAt,
          }),
        ),
      )).id,
    );
    const { POST: setPOST } = await import("@/app/api/v1/sessions/[id]/sets/route");
    const doneAt = new Date(Date.now() - 28 * 3_600_000).toISOString();
    await setPOST(
      req("POST", `/api/v1/sessions/${withSet}/sets`, {
        client_key: "duration-orphan-set-1",
        exercise_id: exerciseId,
        set_no: 1,
        weight_kg: 30,
        reps: 10,
        done_at: doneAt,
      }),
      params({ id: String(withSet) }),
    );

    const aborted = abortOrphanSessions(getDb(), Date.now());
    expect(aborted).toBeGreaterThanOrEqual(2);

    const rows = getDb()
      .select({ id: schema.workoutSession.id, status: schema.workoutSession.status, endedAt: schema.workoutSession.endedAt })
      .from(schema.workoutSession)
      .where(eq(schema.workoutSession.status, "aborted"))
      .all();
    expect(rows.find((r) => r.id === withSet)?.endedAt).toBe(doneAt);
    expect(rows.find((r) => r.id === noSet)?.endedAt).toBeNull();
  });
});
