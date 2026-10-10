/**
 * v1.28：GET /api/v1/schedule/upcoming —— 助手对拍用的「未来 N 天排期事实」（只读）。
 *
 * 钉住四件事：
 * 1. **形状**：days 条连续日期、字段齐全、`cycle_len` 与方案一致；
 * 2. **同源**：今天与 `GET /today` 的五字段逐字段一致；明天用 `/today` 的 `day_types` 交叉验证
 *    —— 注意 `GET /today?date=` 从 v1.1 起就不接受未来日（补记专用），所以未来天没法走那条路比对，
 *    这里用 `/today` 自己的 `day_types`（含今天与明天）补上明天那一格，其余天靠"同窗口不同 days 自洽"；
 * 3. **参数**：`days` 越界 / `from` 不是今天 → 400；
 * 4. **归因**：顺延日、法定节假日、加练位点如实标注 `deferred`，且 `cycle_index` 与"顺延后的排期"一致；
 *    顺带钉住"纯读"：调它不改库里任何一行。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-upcoming-"));
process.env.DATABASE_FILE = join(dir, "upcoming.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

const routes = {
  upcoming: async () =>
    (await import("@/app/api/v1/schedule/upcoming/route")) as { GET: Handler },
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  skip: async () => (await import("@/app/api/v1/skip/route")) as { POST: Handler },
  skipDate: async () => (await import("@/app/api/v1/skip/[date]/route")) as { DELETE: Handler },
  holidays: async () => (await import("@/app/api/v1/holidays/route")) as { GET: Handler; PUT: Handler },
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

interface UpcomingItem {
  date: string;
  weekday: string;
  part: string;
  is_training_day: boolean;
  cycle_index: number;
  holiday: string | null;
  deferred: "holiday" | "skip" | "extra_shift" | null;
}
interface UpcomingPayload {
  from: string;
  days: number;
  cycle_len: number;
  items: UpcomingItem[];
}

let today = "";
let addDays: (d: string, n: number) => string;

async function upcoming(days?: number, from?: string): Promise<UpcomingPayload> {
  const { GET } = await routes.upcoming();
  const qs = [days === undefined ? "" : `days=${days}`, from === undefined ? "" : `from=${from}`]
    .filter(Boolean)
    .join("&");
  const res = await GET(req("GET", `/api/v1/schedule/upcoming${qs ? `?${qs}` : ""}`));
  expect(res.status).toBe(200);
  return jsonOf<UpcomingPayload>(res);
}

/** 窗口里第一个训练日（顺延只受理训练日，13.8 v1.23） */
function firstTrainingDay(items: UpcomingItem[]): UpcomingItem {
  const found = items.find((it) => it.is_training_day);
  expect(found).toBeTruthy();
  return found as UpcomingItem;
}

beforeAll(async () => {
  const time = await import("@/lib/time");
  today = time.dateInTz();
  addDays = time.addDays;
  // 首次访问即触发建库 + 种子（与生产同一条路径）
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

describe("形状与参数（验收 1 / 3）", () => {
  it("缺省 days=14：14 条连续日期，最后一条 = from + 13 天，字段齐全", async () => {
    const body = await upcoming();
    expect(body.from).toBe(today);
    expect(body.days).toBe(14);
    expect(body.cycle_len).toBe(4); // 默认方案 = 四天循环
    expect(body.items).toHaveLength(14);

    body.items.forEach((it, i) => {
      expect(it.date).toBe(addDays(today, i));
      expect(it.weekday).toMatch(/^周[一二三四五六日]$/);
      expect(it.part.length).toBeGreaterThan(0);
      expect(typeof it.is_training_day).toBe("boolean");
      expect(Number.isInteger(it.cycle_index)).toBe(true);
      expect(it.cycle_index).toBeGreaterThanOrEqual(0);
      expect(it.cycle_index).toBeLessThan(body.cycle_len);
      expect([null, "holiday", "skip", "extra_shift"]).toContain(it.deferred);
    });
    expect(body.items.at(-1)?.date).toBe(addDays(today, 13));
  });

  it("days 边界：1 与 60 收；0 / 61 / 非整数 → 400", async () => {
    expect((await upcoming(1)).items).toHaveLength(1);
    expect((await upcoming(60)).items).toHaveLength(60);
    const { GET } = await routes.upcoming();
    for (const bad of ["0", "61", "-1", "abc", "2.5"]) {
      const res = await GET(req("GET", `/api/v1/schedule/upcoming?days=${bad}`));
      expect(res.status).toBe(400);
    }
  });

  it("from：今天与缺省等价；昨天 / 明天 / 坏格式 → 400（验收 3）", async () => {
    const withFrom = await upcoming(3, today);
    const without = await upcoming(3);
    expect(withFrom.items).toEqual(without.items);

    const { GET } = await routes.upcoming();
    const yesterday = await GET(req("GET", `/api/v1/schedule/upcoming?from=${addDays(today, -1)}`));
    expect(yesterday.status).toBe(400);
    expect(String((await jsonOf(yesterday)).error)).toContain("早于今天");

    const tomorrow = await GET(req("GET", `/api/v1/schedule/upcoming?from=${addDays(today, 1)}`));
    expect(tomorrow.status).toBe(400);

    expect((await GET(req("GET", "/api/v1/schedule/upcoming?from=2026-99-99"))).status).toBe(400);
  });

  it("纯读：调用前后库里一行都不动（验收 5）", async () => {
    const { getSqlite } = await import("@/db/client");
    const counts = () =>
      getSqlite()
        .prepare(
          "select (select count(*) from skip_day) as skips, (select count(*) from cycle_point) as points, (select count(*) from holiday) as holidays, (select count(*) from set_log) as sets",
        )
        .get() as Record<string, number>;
    const before = counts();
    await upcoming(14);
    await upcoming(60, today);
    expect(counts()).toEqual(before);
  });
});

describe("与 GET /today 同源（验收 2）", () => {
  it("今天的五个字段逐字段一致", async () => {
    const { GET } = await routes.today();
    const day = await jsonOf<{
      date: string;
      part: string;
      isTrainingDay: boolean;
      holiday: { name: string; type: string } | null;
      deferred: string | null;
      scheme: { slotIndex: number };
    }>(await GET(req("GET", "/api/v1/today")));
    const item = (await upcoming(1)).items[0];

    expect(item.date).toBe(day.date);
    expect(item.part).toBe(day.part);
    expect(item.is_training_day).toBe(day.isTrainingDay);
    expect(item.cycle_index).toBe(day.scheme.slotIndex);
    expect(item.holiday).toBe(day.holiday && day.holiday.type === "holiday" ? day.holiday.name : null);
    expect(item.deferred).toBe(day.deferred);
  });

  it("明天：与 /today 的 day_types 交叉验证（那条路不接受未来日）", async () => {
    const { GET } = await routes.today();
    const day = await jsonOf<{ dayTypes: Record<string, "training" | "rest" | "holiday"> }>(
      await GET(req("GET", "/api/v1/today")),
    );
    const item = (await upcoming(2)).items[1];
    const kind = day.dayTypes[item.date];
    expect(kind).toBeTruthy();
    expect(item.is_training_day).toBe(kind === "training");
    if (kind === "holiday") {
      expect(item.holiday).toBeTruthy();
      expect(item.deferred).toBe("holiday");
    } else {
      expect(item.holiday).toBeNull();
    }
  });

  it("自洽：同一天在 1 / 14 / 60 天窗口里是同一份数据（不会因窗口长度漂移）", async () => {
    const one = await upcoming(1);
    const fourteen = await upcoming(14);
    const sixty = await upcoming(60);
    expect(fourteen.items[0]).toEqual(one.items[0]);
    expect(sixty.items.slice(0, 14)).toEqual(fourteen.items);
  });
});

describe("顺延 / 假期 / 加练位点如实标注（验收 4）", () => {
  it("顺延日：deferred=skip、该日仍显示原部位，次日循环位不前进（部位顺延）", async () => {
    const before = await upcoming(14);
    const target = firstTrainingDay(before.items);
    const nextDayItem = before.items[before.items.indexOf(target) + 1];
    expect(nextDayItem).toBeTruthy();

    const { POST } = await routes.skip();
    const res = await POST(req("POST", "/api/v1/skip", { date: target.date, reason: "missed" }));
    expect(res.status).toBe(201);

    const after = await upcoming(14);
    const skipped = after.items.find((it) => it.date === target.date)!;
    expect(skipped.part).toBe(target.part); // 那天该练什么没变
    expect(skipped.deferred).toBe("skip");
    // 顺延日不占循环位 → 次日仍是同一个部位（欠账顺延到下一个训练日，13.8）
    const next = after.items.find((it) => it.date === nextDayItem.date)!;
    expect(next.part).toBe(target.part);

    const { DELETE } = await routes.skipDate();
    await DELETE(req("DELETE", `/api/v1/skip/${target.date}`), params({ date: target.date }));
    const restored = await upcoming(14);
    expect(restored.items).toEqual(before.items);
  });

  it("加练位点：从位点那天起 deferred=extra_shift，循环位按位点重算", async () => {
    const before = await upcoming(14);
    // 找一个"前一天是普通日、且后面还有一天"的日子放位点（窗口里可能有种子假期，别写死下标）
    const idx = before.items.findIndex(
      (it, i) => i > 0 && i + 1 < before.items.length && it.deferred === null && before.items[i - 1].deferred === null,
    );
    expect(idx).toBeGreaterThan(0);
    const pointDate = before.items[idx].date;

    const { getSqlite } = await import("@/db/client");
    const schemeId = (
      getSqlite().prepare("select id from split_scheme where active = 1").get() as { id: string }
    ).id;
    // 位点 = 那天循环位为 0（13.17：加练时写入的那条；这里直接入库造情境）
    getSqlite()
      .prepare("insert into cycle_point (scheme_id, date, position, reason, note) values (?, ?, 0, 'extra', ?)")
      .run(schemeId, pointDate, "测试：加练位点");

    const after = await upcoming(14);
    expect(after.items[idx - 1].deferred).toBe(null); // 位点只影响该日及以后
    expect(after.items[idx].deferred).toBe("extra_shift");
    expect(after.items[idx].cycle_index).toBe(0);
    expect(after.items[idx + 1].deferred).not.toBe(null); // 之后的日子都算"被挪过"（假期优先报 holiday）

    getSqlite().prepare("delete from cycle_point where date = ? and reason = 'extra'").run(pointDate);
    expect((await upcoming(14)).items).toEqual(before.items);
  });

  it("法定节假日：holiday 给名字、不是训练日；补班日不算假期（仍占循环位）", async () => {
    const { PUT } = await routes.holidays();
    const holidayDate = addDays(today, 5);
    const makeupDate = addDays(today, 6);
    const year = Number(today.slice(0, 4));
    const res = await PUT(
      req("PUT", "/api/v1/holidays", {
        year,
        days: [
          { date: holidayDate, name: "测试假期", type: "holiday" },
          { date: makeupDate, name: "补班", type: "workday" },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const items = (await upcoming(14)).items;
    const hol = items.find((it) => it.date === holidayDate)!;
    expect(hol.holiday).toBe("测试假期");
    expect(hol.deferred).toBe("holiday");
    expect(hol.is_training_day).toBe(false);
    // 假期不占循环位 → 后一天循环位不前进
    const afterHol = items.find((it) => it.date === addDays(holidayDate, 1))!;
    expect(afterHol.cycle_index).toBe(hol.cycle_index);

    const makeup = items.find((it) => it.date === makeupDate)!;
    expect(makeup.holiday).toBeNull(); // 补班日不是假期（13.7 的坑：它要占位）
    expect(makeup.deferred).toBe(null);
  });
});
