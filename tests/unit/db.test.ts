/**
 * 数据层单测（阶段 2 验收：迁移可重放、种子只注入一次、幂等写入口）。
 *
 * 每个用例用独立的临时库文件（`openDatabase`），跑完删掉 —— 不碰开发库。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { seedOnce } from "@/db/seed";
import {
  abortOrphanSessions,
  addOvertime,
  appendAnchor,
  createAnchorProposal,
  createSession,
  decideAnchorProposal,
  deleteOvertime,
  ensureCheckin,
  ensureReminderEvent,
  ensureSkip,
  markDelivery,
  recordCheatMeal,
  removeSkip,
  setSetting,
  upsertBodyMetric,
  upsertSetLog,
  updateOvertime,
  getOvertime,
} from "@/db/writes";
import {
  HolidayValidationError,
  holidayGapHandledAt,
  holidayWriteMeta,
  holidaysInYear,
  recordHolidayCheck,
  replaceHolidayYear,
} from "@/db/holidays";
import { makeBackup, listBackups } from "@/db/backup";
import {
  bodySeries,
  historyRows,
  latestBodyMetric,
  latestSetByExerciseVariant,
  loadScheduleState,
  recordedDates,
  todayFacts,
} from "@/db/queries";
import { EXERCISES, HOLIDAY_SEED_2026, SCHEMES } from "@/data";

const dir = mkdtempSync(join(tmpdir(), "fitness-db-"));
let counter = 0;
const opened: { sqlite: { close: () => void } }[] = [];
function freshDb(): { db: Db; file: string } {
  const file = join(dir, `test-${counter++}.sqlite`);
  const holder = openDatabase(file);
  opened.push(holder);
  return { db: holder.db, file };
}

afterAll(() => {
  // Windows 上必须先关连接再删文件（否则 EBUSY）
  for (const h of opened) {
    try {
      h.sqlite.close();
    } catch {
      // 已经关过的忽略
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("迁移与种子（阶段 2 验收）", () => {
  it("全新库：迁移建全表 + 种子注入一次", () => {
    const { db } = freshDb();
    // 动作库条数从种子取（条数本身由 caliber.test.ts 的「种子数据自检」钉住，别在两处各写一个数字）
    expect(db.select().from(schema.exercise).all()).toHaveLength(EXERCISES.length);
    expect(db.select().from(schema.splitScheme).all()).toHaveLength(SCHEMES.length);
    expect(db.select().from(schema.cycleTemplate).all().length).toBe(
      SCHEMES.reduce((n, s) => n + s.slots.length, 0),
    );
    expect(db.select().from(schema.holiday).all()).toHaveLength(Object.keys(HOLIDAY_SEED_2026).length);
    // 种子也写元信息：设置页才能显示「最近更新于 X · 来源 安装种子」（BUG-5 回归）
    const seedMeta = holidayWriteMeta(db);
    expect(seedMeta.source).toBe("seed");
    expect(seedMeta.updatedAt).not.toBeNull();
    expect(db.select().from(schema.supplement).all()).toHaveLength(4);
    expect(db.select().from(schema.scheduleAnchor).all()).toHaveLength(SCHEMES.length);
    expect(db.select().from(schema.cheatSetting).all()).toHaveLength(1);
    expect(db.select().from(schema.user).all()).toHaveLength(1);
    // 演示数据不迁移：空库起（第 12 章第 18 条）
    expect(db.select().from(schema.workoutSession).all()).toHaveLength(0);
    expect(db.select().from(schema.bodyMetric).all()).toHaveLength(0);
    // 迁移 0004 建出来的新表（FR-57 每日体重分析）：空库也是「有表、无数据」
    expect(db.select().from(schema.bodyAnalysis).all()).toHaveLength(0);
  });

  it("重启 / 重开：种子不会重复注入（只注入一次，13.12）", () => {
    const file = join(dir, "restart.sqlite");
    const first = openDatabase(file);
    const before = first.db.select().from(schema.exercise).all().length;
    first.sqlite.close();

    const second = openDatabase(file);
    expect(second.db.select().from(schema.exercise).all().length).toBe(before);
    expect(second.db.select().from(schema.holiday).all().length).toBe(
      Object.keys(HOLIDAY_SEED_2026).length,
    );
    expect(seedOnce(second.db).seeded).toBe(false);
    second.sqlite.close();
  });

  it("假期表被清空后不会自己长回来（种子不是永久地板）", () => {
    const { db } = freshDb();
    db.delete(schema.holiday).run();
    expect(db.select().from(schema.holiday).all()).toHaveLength(0);
    expect(seedOnce(db).seeded).toBe(false); // 重启也不会补
    expect(db.select().from(schema.holiday).all()).toHaveLength(0);
  });

  it("槽位动作清单：gym / home 两套独立，动作名解析得到 exercise_id", () => {
    const { db } = freshDb();
    const rows = db.select().from(schema.cycleExercise).all();
    const gym = rows.filter((r) => r.mode === "gym");
    const home = rows.filter((r) => r.mode === "home");
    expect(gym.length).toBeGreaterThan(0);
    expect(home.length).toBeGreaterThan(0);
    expect(gym.length).not.toBe(home.length);
  });

  it("默认锚点与对拍基线一致（2026-09-21 / position 0）", () => {
    const { db } = freshDb();
    const anchor = db
      .select()
      .from(schema.scheduleAnchor)
      .all()
      .find((a) => a.schemeId === "cycle4");
    expect(anchor?.anchorDate).toBe("2026-09-21");
    expect(anchor?.cyclePosition).toBe(0);
  });
});

describe("幂等写入口（需求书第 7 章）", () => {
  let db: Db;
  beforeAll(() => {
    db = freshDb().db;
  });

  it("体重：(date, slot) 覆盖而不是两条；不同时点各存一条", () => {
    upsertBodyMetric(db, { date: "2026-09-28", weightKg: 70.2, slot: "morning" });
    upsertBodyMetric(db, { date: "2026-09-28", weightKg: 70.5, slot: "morning" });
    upsertBodyMetric(db, { date: "2026-09-28", weightKg: 71.6, slot: "bedtime" });
    expect(db.select().from(schema.bodyMetric).all()).toHaveLength(2);
    const morning = db
      .select()
      .from(schema.bodyMetric)
      .all()
      .find((m) => m.slot === "morning");
    expect(morning?.weightKg).toBe(70.5);
    // 首页大数字优先 morning（13.2）
    expect(latestBodyMetric(db, "2026-09-28").latestMorning?.weightKg).toBe(70.5);
    expect(bodySeries(db).map((b) => b.date)).toEqual(["2026-09-28", "2026-09-28"]);
  });

  it("打卡按 (date, kind, ref_id) 去重", () => {
    expect(ensureCheckin(db, { date: "2026-09-28", kind: "workout", source: "web" }).created).toBe(true);
    expect(ensureCheckin(db, { date: "2026-09-28", kind: "workout", source: "reminder" }).created).toBe(false);
    expect(ensureCheckin(db, { date: "2026-09-28", kind: "supplement", refId: 1, source: "web" }).created).toBe(true);
    expect(ensureCheckin(db, { date: "2026-09-28", kind: "supplement", refId: 1, source: "web" }).created).toBe(false);
    expect(db.select().from(schema.checkin).all()).toHaveLength(2);
  });

  it("顺延：同日一条（重复 = no-op），撤销后删掉", () => {
    expect(ensureSkip(db, { date: "2026-09-29", reason: "overtime" }).created).toBe(true);
    expect(ensureSkip(db, { date: "2026-09-29", reason: "missed" }).created).toBe(false);
    expect(db.select().from(schema.skipDay).all()).toHaveLength(1);
    expect(removeSkip(db, "2026-09-29").removed).toBe(true);
    expect(db.select().from(schema.skipDay).all()).toHaveLength(0);
    expect(removeSkip(db, "2026-09-29").removed).toBe(false);
  });

  it("会话：同一 client_id 重复提交 3 次 → 库里只有 1 场（响应为既有会话）", () => {
    const input = {
      clientId: "c-1111",
      date: "2026-09-28",
      part: "背+二头",
      mode: "gym" as const,
      status: "doing" as const,
    };
    const a = createSession(db, input);
    const b = createSession(db, input);
    const c = createSession(db, input);
    expect([a.created, b.created, c.created]).toEqual([true, false, false]);
    expect(b.id).toBe(a.id);
    expect(db.select().from(schema.workoutSession).all()).toHaveLength(1);
  });

  it("组记录：client_key 幂等（重放 = 覆盖同一组）", () => {
    const session = createSession(db, {
      clientId: "c-2222",
      date: "2026-09-28",
      part: "背+二头",
      mode: "gym",
      status: "doing",
    });
    const first = upsertSetLog(db, {
      clientKey: "c-2222:1:3",
      sessionId: session.id,
      exerciseId: 1,
      setNo: 1,
      weightKg: 20,
      reps: 12,
      totalLoadKg: 60,
    });
    const again = upsertSetLog(db, {
      clientKey: "c-2222:1:3",
      sessionId: session.id,
      exerciseId: 1,
      setNo: 1,
      weightKg: 22.5,
      reps: 12,
      totalLoadKg: 65,
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    const rows = db.select().from(schema.setLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].weightKg).toBe(22.5);
  });

  it("「照上次填」按「动作 × 变体」分组：换变体拿不到另一台机器的记录", () => {
    const exercise = db
      .select()
      .from(schema.exercise)
      .all()
      .find((e) => e.name === "高位下拉");
    if (!exercise) throw new Error("动作库里没有高位下拉");
    const variant = db
      .select()
      .from(schema.exerciseVariant)
      .all()
      .find((v) => v.exerciseId === exercise.id && v.code === "v-cable");
    if (!variant) throw new Error("高位下拉没有 v-cable 变体");

    upsertSetLog(db, {
      clientKey: "hist-default",
      sessionId: 1,
      exerciseId: exercise.id,
      setNo: 1,
      weightKg: 50,
      reps: 12,
      doneAt: "2026-09-20T12:00:00.000Z",
    });
    upsertSetLog(db, {
      clientKey: "hist-cable",
      sessionId: 1,
      exerciseId: exercise.id,
      setNo: 1,
      variantId: variant.id,
      weightKg: 25,
      reps: 12,
      doneAt: "2026-09-20T12:10:00.000Z",
    });

    const map = latestSetByExerciseVariant(db);
    const byVariant = map.get(exercise.id);
    expect(byVariant?.get("default")?.weightKg).toBe(50);
    expect(byVariant?.get(String(variant.id))?.weightKg).toBe(25);
  });

  it("孤儿会话：started_at 超 24 小时的 planned/doing → aborted（4.2）", () => {
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    createSession(db, {
      clientId: "orphan-1",
      date: "2026-09-26",
      part: "胸+三头",
      mode: "gym",
      status: "doing",
      startedAt: old,
    });
    createSession(db, {
      clientId: "orphan-2",
      date: "2026-09-27",
      part: "肩+腿",
      mode: "gym",
      status: "planned",
      startedAt: old,
    });
    createSession(db, {
      clientId: "recent-1",
      date: "2026-09-28",
      part: "背+二头",
      mode: "gym",
      status: "doing",
      startedAt: new Date().toISOString(),
    });
    const changed = abortOrphanSessions(db, Date.now());
    expect(changed).toBe(2);
    const statuses = Object.fromEntries(
      db.select().from(schema.workoutSession).all().map((s) => [s.clientId, s.status]),
    );
    expect(statuses["orphan-1"]).toBe("aborted");
    expect(statuses["orphan-2"]).toBe("aborted");
    expect(statuses["recent-1"]).toBe("doing");
  });

  it("锚点只追加；重锚建议可接受/拒绝", () => {
    const before = db.select().from(schema.scheduleAnchor).all().length;
    appendAnchor(db, { schemeId: "cycle4", anchorDate: "2026-10-20", cyclePosition: 1, reason: "manual" });
    expect(db.select().from(schema.scheduleAnchor).all().length).toBe(before + 1);
    const proposal = createAnchorProposal(db, { date: "2026-10-20", suggestedPosition: 1 });
    expect(decideAnchorProposal(db, proposal.id, "rejected").updated).toBe(true);
    expect(db.select().from(schema.anchorProposal).all()[0].status).toBe("rejected");
  });

  it("加班：录入 / 修改（判定立刻重算的数据源）/ 删除", () => {
    const ot = addOvertime(db, { date: "2026-09-28", start: "20:00", note: "上线" });
    expect(getOvertime(db, ot.id)?.startTime).toBe("20:00");
    updateOvertime(db, ot.id, { start: "23:30" });
    expect(getOvertime(db, ot.id)?.startTime).toBe("23:30");
    expect(deleteOvertime(db, ot.id).removed).toBe(true);
    expect(getOvertime(db, ot.id)).toBeNull();
  });

  it("提醒事件按 (type, ref_key, date) 去重；投递按渠道各一条", () => {
    const a = ensureReminderEvent(db, { type: "workout", refKey: "workout", date: "2026-09-28" });
    const b = ensureReminderEvent(db, { type: "workout", refKey: "workout", date: "2026-09-28" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(markDelivery(db, { eventId: a.id, channel: "feishu" }).created).toBe(true);
    expect(markDelivery(db, { eventId: a.id, channel: "feishu" }).created).toBe(false);
    expect(markDelivery(db, { eventId: a.id, channel: "pwa" }).created).toBe(true);
    expect(db.select().from(schema.reminderDelivery).all()).toHaveLength(2);
  });

  it("放纵餐：报「吃了」→ 锚点挪到今天", () => {
    recordCheatMeal(db, { date: "2026-09-25", note: "火锅" });
    expect(db.select().from(schema.cheatSetting).all()[0].anchorDate).toBe("2026-09-25");
  });

  it("设置项可覆盖（提醒时间改完立即生效的数据源）", () => {
    setSetting(db, "reminder_time", "22:00");
    const row = db.select().from(schema.appSetting).all().find((s) => s.key === "reminder_time");
    expect(row?.value).toBe("22:00");
  });
});

describe("假期表写入（FR-24 / 13.12）", () => {
  it("整年原子覆盖 + 幂等：写两次不同内容 → 第二次为准，不是追加", () => {
    const { db } = freshDb();
    const first = replaceHolidayYear(db, {
      year: 2027,
      days: [
        { date: "2027-01-01", name: "元旦", type: "holiday" },
        { date: "2027-02-06", name: "春节", type: "holiday" },
      ],
    });
    expect(first.written).toBe(2);
    const second = replaceHolidayYear(db, {
      year: 2027,
      days: [{ date: "2027-01-01", name: "元旦", type: "holiday" }],
    });
    expect(second.written).toBe(1);
    expect(holidaysInYear(db, 2027)).toHaveLength(1);
    // 2026 的表不受影响（只覆盖指定年份）
    expect(holidaysInYear(db, 2026).length).toBe(Object.keys(HOLIDAY_SEED_2026).length);
    // 幂等：再写同一份，结果一致
    expect(replaceHolidayYear(db, {
      year: 2027,
      days: [{ date: "2027-01-01", name: "元旦", type: "holiday" }],
    }).written).toBe(1);
    expect(holidaysInYear(db, 2027)).toHaveLength(1);
  });

  it("校验不通过整单拒绝，库里仍是写入前的表", () => {
    const { db } = freshDb();
    const before = holidaysInYear(db, 2027);
    expect(() =>
      replaceHolidayYear(db, {
        year: 2027,
        days: [
          { date: "2027-01-01", name: "元旦", type: "holiday" },
          { date: "2026-01-01", name: "跨年错位", type: "holiday" },
        ],
      }),
    ).toThrow(HolidayValidationError);
    expect(() =>
      replaceHolidayYear(db, {
        year: 2027,
        days: [{ date: "2027-01-01", name: "元旦", type: "festival" }],
      }),
    ).toThrow(HolidayValidationError);
    expect(() =>
      replaceHolidayYear(db, {
        year: 2027,
        days: [
          { date: "2027-01-01", name: "元旦", type: "holiday" },
          { date: "2027-01-01", name: "重复", type: "holiday" },
        ],
      }),
    ).toThrow(HolidayValidationError);
    expect(holidaysInYear(db, 2027)).toEqual(before);
  });

  it("写入记 updated_at 与 source（设置页展示「假期表更新于 X」）", () => {
    const { db } = freshDb();
    const res = replaceHolidayYear(db, {
      year: 2027,
      days: [{ date: "2027-01-01", name: "元旦", type: "holiday" }],
    }, { source: "assistant" });
    const meta = holidayWriteMeta(db);
    expect(meta.updatedAt).toBe(res.updatedAt);
    expect(meta.source).toBe("assistant");
  });

  it("补班日类型保留（type=workday 与 holiday 互斥地存下来）", () => {
    const { db } = freshDb();
    replaceHolidayYear(db, {
      year: 2027,
      days: [
        { date: "2027-02-13", name: "春节补班", type: "workday" },
        { date: "2027-02-06", name: "春节", type: "holiday" },
      ],
    });
    const rows = holidaysInYear(db, 2027);
    expect(rows.find((r) => r.date === "2027-02-13")?.type).toBe("workday");
    // 覆盖期看的是"表里最大年份"（13.12）：2027 在表里 → 覆盖期 2027-12-31
    const state = loadScheduleState(db, "2026-11-01");
    expect(state.holidayCoverageEnd).toBe("2027-12-31");
    expect(state.holidayCoverageEnough).toBe(true);
  });

  it("holiday_gap 的「已处理」时间取事件与助手回执里较晚的一个", () => {
    const { db } = freshDb();
    expect(holidayGapHandledAt(db, "coverage:2026-12-31")).toBeNull();
    ensureReminderEvent(db, {
      type: "holiday_gap",
      refKey: "coverage:2026-12-31",
      date: "2026-11-20",
    });
    expect(holidayGapHandledAt(db, "coverage:2026-12-31")).toBe("2026-11-20");
    recordHolidayCheck(db, "coverage:2026-12-31", "2026-12-01");
    expect(holidayGapHandledAt(db, "coverage:2026-12-31")).toBe("2026-12-01");
    // 表补上之后引用键变了 → 新键没有"已处理"记录，自检自动重新武装
    expect(holidayGapHandledAt(db, "coverage:2027-12-31")).toBeNull();
  });
});

describe("备份（NFR-5 / 13.13）", () => {
  it("用 VACUUM INTO 生成快照：WAL 里的最新事务也在，份数按 keep 截断", () => {
    process.env.BACKUP_DIR = join(dir, "backups");
    try {
      const { db } = freshDb();
      upsertBodyMetric(db, { date: "2026-09-28", weightKg: 70.2 });
      const first = makeBackup(db, new Date("2026-09-28T22:30:00+08:00"), 2);
      expect(existsSync(first.file)).toBe(true);

      // 备份库能独立打开，而且含最新事务（直接复制 .sqlite 就没有这一条）
      const copy = openDatabase(first.file, false);
      expect(copy.db.select().from(schema.bodyMetric).all()).toHaveLength(1);
      copy.sqlite.close();

      makeBackup(db, new Date("2026-09-28T23:30:00+08:00"), 2);
      makeBackup(db, new Date("2026-09-28T23:59:00+08:00"), 2);
      expect(listBackups()).toHaveLength(2);
      expect(listBackups()[0].file.startsWith("fitness-")).toBe(true);
    } finally {
      delete process.env.BACKUP_DIR;
    }
  });
});

describe("读取模型", () => {
  it("排期状态：假期集合只含 holiday，补班日单独在 makeupSet 里", () => {
    const { db } = freshDb();
    const state = loadScheduleState(db, "2026-09-28");
    expect(state.holidaySet.has("2026-09-25")).toBe(true);
    expect(state.holidaySet.has("2026-10-10")).toBe(false); // 补班日不算假期
    expect(state.makeupSet.has("2026-10-10")).toBe(true);
    expect(state.ctx.cycleLen).toBe(4);
    expect(state.slots.map((s) => s.label)).toEqual(["背+二头", "胸+三头", "肩+腿", "休"]);
    expect(state.slots[0].gym.length).toBeGreaterThan(0);
    expect(state.slots[0].home.length).toBeGreaterThan(0);
  });

  it("今日部位与基线一致（9-28 = 背+二头），补班日 10-10 是训练日", () => {
    const { db } = freshDb();
    const facts = todayFacts(db, "2026-09-28");
    expect(facts.slot?.label).toBe("背+二头");
    expect(facts.isTrainingDay).toBe(true);
    expect(facts.holiday).toBeNull();
    const makeup = todayFacts(db, "2026-10-10");
    expect(makeup.slot?.label).toBe("胸+三头");
    expect(makeup.isTrainingDay).toBe(true); // 周六补班照练
  });

  it("假期当天：holiday 有名字、isTrainingDay=false", () => {
    const { db } = freshDb();
    const facts = todayFacts(db, "2026-09-26");
    expect(facts.holiday?.name).toBe("中秋节");
    expect(facts.isTrainingDay).toBe(false);
  });

  it("streak 的数据源：训练 / 打卡 / 体重都算，补剂打卡不算（13.6）", () => {
    const { db } = freshDb();
    upsertBodyMetric(db, { date: "2026-09-20", weightKg: 70 });
    createSession(db, {
      clientId: "streak-1",
      date: "2026-09-21",
      part: "背+二头",
      mode: "gym",
      status: "done",
    });
    ensureCheckin(db, { date: "2026-09-22", kind: "workout", source: "reminder" });
    ensureCheckin(db, { date: "2026-09-23", kind: "supplement", refId: 1, source: "web" });
    createSession(db, {
      clientId: "aborted-1",
      date: "2026-09-24",
      part: "休",
      mode: "gym",
      status: "aborted",
    });
    const dates = recordedDates(db);
    expect(dates.has("2026-09-20")).toBe(true);
    expect(dates.has("2026-09-21")).toBe(true);
    expect(dates.has("2026-09-22")).toBe(true);
    expect(dates.has("2026-09-23")).toBe(false); // 补剂打卡不参与 streak
    expect(dates.has("2026-09-24")).toBe(false); // aborted 不算练完
  });

  it("历史列表：会话行 + 「已打卡 · 无明细」行（13.4）", () => {
    const { db } = freshDb();
    ensureCheckin(db, { date: "2026-09-20", kind: "workout", source: "reminder" });
    createSession(db, {
      clientId: "hist-1",
      date: "2026-09-21",
      part: "背+二头",
      mode: "gym",
      status: "done",
      startedAt: "2026-09-21T11:00:00.000Z",
    });
    const rows = historyRows(db);
    expect(rows.map((r) => `${r.date}:${r.kind}`)).toEqual([
      "2026-09-21:session",
      "2026-09-20:checkin",
    ]);
  });
});
