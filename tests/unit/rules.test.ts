/**
 * 规则管理（v1.2）的接口级测试：分化方案 / 槽位与清单 / 动作库与器械变体 / 补剂清单 / 设置。
 *
 * 对着真实路由处理器跑（与 tests/unit/api.test.ts 同一套做法）：
 * 环境变量先设好再动态 import，数据库换成临时文件。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "fitness-rules-"));
process.env.DATABASE_FILE = join(dir, "rules.sqlite");
process.env.DATA_DIR = dir;
process.env.API_TOKEN = "test-token";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_USERNAME = "me";

const BASE = "http://localhost:3210";

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

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

const routes = {
  schemes: async () => (await import("@/app/api/v1/schemes/route")) as { GET: Handler; POST: Handler },
  scheme: async () => (await import("@/app/api/v1/schemes/[id]/route")) as { PATCH: Handler; DELETE: Handler },
  slots: async () => (await import("@/app/api/v1/schemes/[id]/slots/route")) as { POST: Handler },
  slot: async () =>
    (await import("@/app/api/v1/schemes/[id]/slots/[templateId]/route")) as { PATCH: Handler; DELETE: Handler },
  slotExercises: async () =>
    (await import("@/app/api/v1/schemes/[id]/slots/[templateId]/exercises/route")) as { PUT: Handler },
  exercises: async () => (await import("@/app/api/v1/exercises/route")) as { GET: Handler; POST: Handler },
  exercise: async () => (await import("@/app/api/v1/exercises/[id]/route")) as { PATCH: Handler; DELETE: Handler },
  variants: async () => (await import("@/app/api/v1/exercises/[id]/variants/route")) as { POST: Handler },
  variant: async () =>
    (await import("@/app/api/v1/exercises/[id]/variants/[variantId]/route")) as { PATCH: Handler; DELETE: Handler },
  supplements: async () => (await import("@/app/api/v1/supplements/route")) as { GET: Handler; POST: Handler },
  supplement: async () => (await import("@/app/api/v1/supplements/[id]/route")) as { PATCH: Handler; DELETE: Handler },
  today: async () => (await import("@/app/api/v1/today/route")) as { GET: Handler },
  settings: async () => (await import("@/app/api/v1/settings/route")) as { GET: Handler; PATCH: Handler },
  sessions: async () => (await import("@/app/api/v1/sessions/route")) as { POST: Handler },
  sets: async () => (await import("@/app/api/v1/sessions/[id]/sets/route")) as { POST: Handler },
  due: async () => (await import("@/app/api/v1/reminders/due/route")) as { GET: Handler },
  reanchor: async () => (await import("@/app/api/v1/reanchor/route")) as { POST: Handler },
};

interface SchemeView {
  id: string;
  name: string;
  note: string;
  active: boolean;
  anchor: { date: string; position: number; reason: string } | null;
  slots: {
    templateId: number;
    position: number;
    label: string;
    rest: boolean;
    muscles: string[];
    gym: { exerciseId: number; name: string; targetSets: number; targetReps: number }[];
    home: { exerciseId: number; name: string }[];
  }[];
}
interface SchemesPayload {
  schemes: SchemeView[];
  activeSchemeId: string;
}
interface LibraryPayload {
  exercises: {
    id: number;
    name: string;
    muscles: string[];
    type: string;
    equip: string;
    loadMode: string;
    defaultSets: number;
    defaultReps: number;
    variants: { id: number; equip: string; semantics: string; label: string }[];
    setCount: number;
    templateRefs: number;
  }[];
  taxonomy: { muscles: string[]; equips: string[] };
}

async function schemes(): Promise<SchemesPayload> {
  const { GET } = await routes.schemes();
  return jsonOf<SchemesPayload>(await GET(req("GET", "/api/v1/schemes")));
}

async function library(): Promise<LibraryPayload> {
  const { GET } = await routes.exercises();
  return jsonOf<LibraryPayload>(await GET(req("GET", "/api/v1/exercises")));
}

async function todayPart(): Promise<string> {
  const { GET } = await routes.today();
  const body = await jsonOf<{ part: string; scheme: { id: string; cycleLen: number; templateId: number | null } }>(
    await GET(req("GET", "/api/v1/today")),
  );
  return body.part;
}

beforeAll(async () => {
  // 首次访问即触发建库 + 种子（与生产同一条路径）
  await todayPart();
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

describe("规则管理 · 分化方案（FR-21 / 设计说明 §4.6）", () => {
  it("种子：5 套方案，默认四天循环在用，槽位与两套清单都在", async () => {
    const payload = await schemes();
    expect(payload.schemes.length).toBe(5);
    expect(payload.activeSchemeId).toBe("cycle4");
    const cycle4 = payload.schemes.find((s) => s.id === "cycle4")!;
    expect(cycle4.active).toBe(true);
    expect(cycle4.slots.map((s) => s.label)).toEqual(["背+二头", "胸+三头", "肩+腿", "休"]);
    expect(cycle4.slots[0].gym.length).toBeGreaterThan(0);
    expect(cycle4.slots[0].home.length).toBeGreaterThan(0);
    expect(cycle4.anchor?.reason).toBe("initial");
  });

  it("复制方案：槽位与清单一起复制，且不自动切过去", async () => {
    const { POST } = await routes.schemes();
    const created = await POST(
      req("POST", "/api/v1/schemes", { name: "我的三分化", copy_from: "cycle4" }),
    );
    expect(created.status).toBe(201);
    const { id } = await jsonOf<{ id: string }>(created);

    const payload = await schemes();
    const copy = payload.schemes.find((s) => s.id === id)!;
    expect(copy.name).toBe("我的三分化");
    expect(copy.active).toBe(false);
    expect(copy.slots.map((s) => s.label)).toEqual(["背+二头", "胸+三头", "肩+腿", "休"]);
    expect(copy.slots[0].gym.length).toBe(
      payload.schemes.find((s) => s.id === "cycle4")!.slots[0].gym.length,
    );

    // 改名重复 → 400
    const { PATCH } = await routes.scheme();
    const clash = await PATCH(req("PATCH", `/api/v1/schemes/${id}`, { name: "四天循环" }), params({ id }));
    expect(clash.status).toBe(400);

    // 删掉（不是当前方案，删得掉）
    const { DELETE } = await routes.scheme();
    expect((await DELETE(req("DELETE", `/api/v1/schemes/${id}`), params({ id }))).status).toBe(200);
    expect((await schemes()).schemes.some((s) => s.id === id)).toBe(false);
  });

  it("切换方案：首次使用从第 1 位开始；切回来原样恢复离开时的位次", async () => {
    const before = await todayPart();
    const { PATCH } = await routes.scheme();
    const { DELETE } = await routes.scheme();

    // 切到三分化（从没用过）→ 今天 = 第 1 位「推」
    expect((await PATCH(req("PATCH", "/api/v1/schemes/ppl3", { active: true }), params({ id: "ppl3" }))).status).toBe(
      200,
    );
    expect((await schemes()).activeSchemeId).toBe("ppl3");
    expect(await todayPart()).toBe("推");

    // 切回四天循环 → 原样恢复（与切走前同一部位）
    await PATCH(req("PATCH", "/api/v1/schemes/cycle4", { active: true }), params({ id: "cycle4" }));
    expect((await schemes()).activeSchemeId).toBe("cycle4");
    expect(await todayPart()).toBe(before);

    // 再切到 ppl3：这次是「切回」→ 回到离开时的位次（第 1 位「推」）
    await PATCH(req("PATCH", "/api/v1/schemes/ppl3", { active: true }), params({ id: "ppl3" }));
    expect(await todayPart()).toBe("推");
    await PATCH(req("PATCH", "/api/v1/schemes/cycle4", { active: true }), params({ id: "cycle4" }));

    // 当前方案删不得
    expect((await DELETE(req("DELETE", "/api/v1/schemes/cycle4"), params({ id: "cycle4" }))).status).toBe(400);
  });
});

describe("规则管理 · 槽位与动作清单", () => {
  it("加槽位 → 循环长度 +1；重名 / 非法肌群整单拒绝；最后一个槽位删不得", async () => {
    const { POST } = await routes.schemes();
    const created = await POST(req("POST", "/api/v1/schemes", { name: "槽位测试方案" }));
    const { id } = await jsonOf<{ id: string }>(created);
    expect((await schemes()).schemes.find((s) => s.id === id)!.slots.length).toBe(0);

    const { POST: addSlot } = await routes.slots();
    const added = await addSlot(
      req("POST", `/api/v1/schemes/${id}/slots`, { name: "腿", rest: false, muscles: ["股四头", "腘绳"] }),
      params({ id }),
    );
    expect(added.status).toBe(201);
    const { id: legId } = await jsonOf<{ id: number }>(added);
    expect((await schemes()).schemes.find((s) => s.id === id)!.slots[0].muscles).toEqual(["股四头", "腘绳"]);

    // 同一方案内重名 → 400
    expect((await addSlot(req("POST", `/api/v1/schemes/${id}/slots`, { name: "腿" }), params({ id }))).status).toBe(400);

    // 不认识的肌群 → 400（13.15 的 15 项口径）
    const badMuscle = await addSlot(
      req("POST", `/api/v1/schemes/${id}/slots`, { name: "手臂", muscles: ["小臂"] }),
      params({ id }),
    );
    expect(badMuscle.status).toBe(400);

    // 唯一一个槽位删不得（循环长度不能为 0）；加到两个之后就能删了
    const { DELETE } = await routes.slot();
    expect(
      (await DELETE(req("DELETE", `/api/v1/schemes/${id}/slots/${legId}`), params({ id, templateId: String(legId) }))).status,
    ).toBe(400);
    const second = await addSlot(req("POST", `/api/v1/schemes/${id}/slots`, { name: "推" }), params({ id }));
    const { id: pushId } = await jsonOf<{ id: number }>(second);
    expect(
      (await DELETE(req("DELETE", `/api/v1/schemes/${id}/slots/${pushId}`), params({ id, templateId: String(pushId) }))).status,
    ).toBe(200);
    expect((await schemes()).schemes.find((s) => s.id === id)!.slots.length).toBe(1);

    const { DELETE: dropScheme } = await routes.scheme();
    await dropScheme(req("DELETE", `/api/v1/schemes/${id}`), params({ id }));
  });

  it("槽位排序：move up/down 与相邻槽位换位", async () => {
    const { POST } = await routes.schemes();
    const created = await POST(req("POST", "/api/v1/schemes", { name: "排序测试", copy_from: "cycle4" }));
    const { id } = await jsonOf<{ id: string }>(created);
    const payload = await schemes();
    const slots = payload.schemes.find((s) => s.id === id)!.slots;
    const first = slots[0];
    const second = slots[1];

    const { PATCH } = await routes.slot();
    await PATCH(
      req("PATCH", `/api/v1/schemes/${id}/slots/${second.templateId}`, { move: "up" }),
      params({ id, templateId: String(second.templateId) }),
    );
    const after = (await schemes()).schemes.find((s) => s.id === id)!.slots.map((s) => s.label);
    expect(after[0]).toBe(second.label);
    expect(after[1]).toBe(first.label);

    // 改槽位名 + 休日 + 肌群
    await PATCH(
      req("PATCH", `/api/v1/schemes/${id}/slots/${first.templateId}`, { name: "拉", rest: true, muscles: ["背"] }),
      params({ id, templateId: String(first.templateId) }),
    );
    const renamed = (await schemes()).schemes.find((s) => s.id === id)!.slots.find((s) => s.templateId === first.templateId)!;
    expect(renamed.label).toBe("拉");
    expect(renamed.rest).toBe(true);
    expect(renamed.muscles).toEqual(["背"]);

    const { DELETE } = await routes.scheme();
    await DELETE(req("DELETE", `/api/v1/schemes/${id}`), params({ id }));
  });

  it("覆盖清单：整表覆盖、顺序 = 数组顺序、两套清单互不影响；/today 立刻按新清单算", async () => {
    const lib = await library();
    const pick = (name: string) => lib.exercises.find((e) => e.name === name)!.id;

    const { POST } = await routes.schemes();
    const created = await POST(req("POST", "/api/v1/schemes", { name: "清单测试", copy_from: "cycle4" }));
    const { id } = await jsonOf<{ id: string }>(created);
    // 切过去，让 /today 读它
    const { PATCH: patchScheme } = await routes.scheme();
    await patchScheme(req("PATCH", `/api/v1/schemes/${id}`, { active: true }), params({ id }));

    const scheme = (await schemes()).schemes.find((s) => s.id === id)!;
    const slot = scheme.slots[0];
    const { PUT } = await routes.slotExercises();
    const put = await PUT(
      req("PUT", `/api/v1/schemes/${id}/slots/${slot.templateId}/exercises`, {
        mode: "gym",
        exercises: [
          { exercise_id: pick("引体向上"), sets: 5, reps: 8 },
          { exercise_id: pick("哑铃弯举"), sets: 3, reps: 12 },
        ],
      }),
      params({ id, templateId: String(slot.templateId) }),
    );
    expect(put.status).toBe(200);

    const { GET: getToday } = await routes.today();
    const todayBody = await jsonOf<{
      scheme: { id: string };
      part: string;
      exercises: { name: string; targetSets: number; targetReps: number }[];
    }>(await getToday(req("GET", "/api/v1/today?mode=gym")));
    expect(todayBody.scheme.id).toBe(id);
    expect(todayBody.part).toBe(slot.label);
    expect(todayBody.exercises.map((e) => e.name)).toEqual(["引体向上", "哑铃弯举"]);
    expect(todayBody.exercises[0].targetSets).toBe(5);

    // 居家清单没动过，仍是复制来的那一套
    const after = (await schemes()).schemes.find((s) => s.id === id)!;
    expect(after.slots[0].home.length).toBe(slot.home.length);
    expect(after.slots[0].gym.length).toBe(2);

    // 重复动作 → 400 整单拒绝
    const dup = await PUT(
      req("PUT", `/api/v1/schemes/${id}/slots/${slot.templateId}/exercises`, {
        mode: "gym",
        exercises: [
          { exercise_id: pick("引体向上"), sets: 4, reps: 8 },
          { exercise_id: pick("引体向上"), sets: 4, reps: 8 },
        ],
      }),
      params({ id, templateId: String(slot.templateId) }),
    );
    expect(dup.status).toBe(400);

    // 不存在的动作 → 400
    const missing = await PUT(
      req("PUT", `/api/v1/schemes/${id}/slots/${slot.templateId}/exercises`, {
        mode: "gym",
        exercises: [{ exercise_id: 999999, sets: 4, reps: 8 }],
      }),
      params({ id, templateId: String(slot.templateId) }),
    );
    expect(missing.status).toBe(400);

    // 切回默认方案，别影响后面的用例
    await patchScheme(req("PATCH", "/api/v1/schemes/cycle4", { active: true }), params({ id: "cycle4" }));
    const { DELETE } = await routes.scheme();
    await DELETE(req("DELETE", `/api/v1/schemes/${id}`), params({ id }));
  });
});

describe("规则管理 · 动作库与器械变体（3.1 / 13.14 / FR-49）", () => {
  it("新增动作：必填与范围校验；重名拒绝", async () => {
    const { POST } = await routes.exercises();
    const base = {
      name: "测试臂屈伸",
      muscles: ["三头"],
      type: "weight",
      equip: "绳索",
      load_mode: "machine",
      sets: 3,
      reps: 12,
    };

    expect((await POST(req("POST", "/api/v1/exercises", { ...base, muscles: [] }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/exercises", { ...base, muscles: ["肱三"] }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/exercises", { ...base, type: "cardio" }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/exercises", { ...base, sets: 0 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/exercises", { ...base, name: "引体向上" }))).status).toBe(400);

    const ok = await POST(req("POST", "/api/v1/exercises", base));
    expect(ok.status).toBe(201);
    const { id } = await jsonOf<{ id: number }>(ok);
    const lib = await library();
    const created = lib.exercises.find((e) => e.id === id)!;
    expect(created.name).toBe("测试臂屈伸");
    expect(created.loadMode).toBe("machine");

    // 改名 + 改参考重量
    const { PATCH } = await routes.exercise();
    expect((await PATCH(req("PATCH", `/api/v1/exercises/${id}`, { name: "测试过顶臂屈伸", base: 15 }), params({ id: String(id) }))).status).toBe(200);
    const renamed = (await library()).exercises.find((e) => e.id === id)!;
    expect(renamed.name).toBe("测试过顶臂屈伸");
  });

  it("器械变体：加变体 → 用它记一组；助力语义不计容量；删被引用过的变体被拒", async () => {
    const lib = await library();
    const exerciseId = lib.exercises.find((e) => e.name === "测试过顶臂屈伸")!.id;

    // 加一个「助力」变体（读数越大越省力 → 不计容量）
    const { POST: addVariant } = await routes.variants();
    const added = await addVariant(
      req("POST", `/api/v1/exercises/${exerciseId}/variants`, {
        equip: "助力器械",
        semantics: "assist",
        label: "靠窗那台",
      }),
      params({ id: String(exerciseId) }),
    );
    expect(added.status).toBe(201);
    const { id: variantId } = await jsonOf<{ id: number }>(added);

    const { POST: createSession } = await routes.sessions();
    const sessionRes = await createSession(
      req("POST", "/api/v1/sessions", {
        client_id: `rules-${Date.now()}`,
        part: "测试",
        mode: "gym",
        status: "doing",
        started_at: new Date().toISOString(),
        exercises: [{ exercise_id: exerciseId, order_no: 0, target_sets: 3, target_reps: 12 }],
      }),
    );
    const { id: sessionId } = await jsonOf<{ id: number }>(sessionRes);

    const { POST: postSet } = await routes.sets();
    const setRes = await postSet(
      req("POST", `/api/v1/sessions/${sessionId}/sets`, {
        client_key: `rules-set-${Date.now()}`,
        exercise_id: exerciseId,
        set_no: 1,
        weight_kg: 40,
        reps: 10,
        variant_id: variantId,
      }),
      params({ id: String(sessionId) }),
    );
    expect(setRes.status).toBe(201);
    const setBody = await jsonOf<{ totalLoadKg: number | null; volumeKg: number }>(setRes);
    expect(setBody.totalLoadKg).toBeNull(); // 助力不计容量（13.14）
    expect(setBody.volumeKg).toBe(0);

    // 变体详情：语义与备注对得上；同一动作的变体列表里有它
    const { PATCH: patchVariant } = await routes.variant();
    const patched = await patchVariant(
      req("PATCH", `/api/v1/exercises/${exerciseId}/variants/${variantId}`, { label: "靠门那台" }),
      params({ id: String(exerciseId), variantId: String(variantId) }),
    );
    expect((await jsonOf<{ label: string }>(patched)).label).toBe("靠门那台");

    // 记过组的变体删不掉（读数语义按变体存着）
    const { DELETE: dropVariant } = await routes.variant();
    const dropRes = await dropVariant(
      req("DELETE", `/api/v1/exercises/${exerciseId}/variants/${variantId}`),
      params({ id: String(exerciseId), variantId: String(variantId) }),
    );
    expect(dropRes.status).toBe(400);

    // 有历史记录的动作也删不掉
    const { DELETE: dropExercise } = await routes.exercise();
    const dropExerciseRes = await dropExercise(req("DELETE", `/api/v1/exercises/${exerciseId}`), params({ id: String(exerciseId) }));
    expect(dropExerciseRes.status).toBe(400);
    expect((await jsonOf<{ error: string }>(dropExerciseRes)).error).toContain("历史记录");
  });

  it("删没有历史的动作：连同方案槽位里的引用一起清掉", async () => {
    const { POST } = await routes.exercises();
    const created = await POST(
      req("POST", "/api/v1/exercises", {
        name: "临时测试动作",
        muscles: ["前臂"],
        type: "reps",
        equip: "自重",
        load_mode: "bodyweight",
        sets: 3,
        reps: 15,
      }),
    );
    const { id } = await jsonOf<{ id: number }>(created);

    // 加进某个方案的槽位清单里
    const payload = await schemes();
    const cycle4 = payload.schemes.find((s) => s.id === "cycle4")!;
    const slot = cycle4.slots[0];
    const { PUT } = await routes.slotExercises();
    await PUT(
      req("PUT", `/api/v1/schemes/cycle4/slots/${slot.templateId}/exercises`, {
        mode: "home",
        exercises: [{ exercise_id: id, sets: 3, reps: 15 }],
      }),
      params({ id: "cycle4", templateId: String(slot.templateId) }),
    );
    expect((await schemes()).schemes.find((s) => s.id === "cycle4")!.slots[0].home.length).toBe(1);

    const { DELETE } = await routes.exercise();
    const dropped = await DELETE(req("DELETE", `/api/v1/exercises/${id}`), params({ id: String(id) }));
    expect(dropped.status).toBe(200);
    expect((await library()).exercises.some((e) => e.id === id)).toBe(false);

    // 清单里也没了（引用被一起清掉）
    const afterScheme = (await schemes()).schemes.find((s) => s.id === "cycle4")!;
    expect(afterScheme.slots[0].home.length).toBe(0);

    // 复原：把居家清单按种子写回去（后面的用例读的是同一份库）
    const lib = await library();
    const homeNames = ["俯卧撑", "徒手深蹲", "平板撑"];
    await PUT(
      req("PUT", `/api/v1/schemes/cycle4/slots/${slot.templateId}/exercises`, {
        mode: "home",
        exercises: homeNames
          .filter((name) => lib.exercises.some((e) => e.name === name))
          .map((name) => ({ exercise_id: lib.exercises.find((e) => e.name === name)!.id, sets: 4, reps: 12 })),
      }),
      params({ id: "cycle4", templateId: String(slot.templateId) }),
    );
  });
});

describe("规则管理 · 补剂清单（FR-33）", () => {
  it("增删改与排序；停用后不再出现在今日补剂里", async () => {
    const { POST } = await routes.supplements();
    const created = await POST(
      req("POST", "/api/v1/supplements", { name: "测试鱼油", times: ["12:00"], dose_text: "2 粒 · 随餐" }),
    );
    expect(created.status).toBe(201);
    const { id } = await jsonOf<{ id: number }>(created);

    // 坏时点 → 400
    expect((await POST(req("POST", "/api/v1/supplements", { name: "坏时点", times: ["25:00"] }))).status).toBe(400);

    const { GET } = await routes.supplements();
    let list = await jsonOf<{ supplements: { id: number; name: string; times: string[]; enabled: boolean }[] }>(
      await GET(req("GET", "/api/v1/supplements")),
    );
    const mine = list.supplements.find((s) => s.id === id)!;
    expect(mine.name).toBe("测试鱼油");
    expect(mine.times).toEqual(["12:00"]);

    // 排序：与自己前面那条换位
    const { PATCH } = await routes.supplement();
    const before = list.supplements.map((s) => s.id);
    await PATCH(req("PATCH", `/api/v1/supplements/${id}`, { move: "up" }), params({ id: String(id) }));
    list = await jsonOf(await GET(req("GET", "/api/v1/supplements")));
    const after = list.supplements.map((s) => s.id);
    expect(after.indexOf(id)).toBe(before.indexOf(id) - 1);

    // 停用 → 今日补剂清单里没有它
    await PATCH(req("PATCH", `/api/v1/supplements/${id}`, { enabled: false }), params({ id: String(id) }));
    const { GET: getToday } = await routes.today();
    const todayBody = await jsonOf<{ supplements: { id: number }[] }>(await getToday(req("GET", "/api/v1/today")));
    expect(todayBody.supplements.some((s) => s.id === id)).toBe(false);
  });

  it("删补剂同时清掉今天尚未投递的补剂提醒事件", async () => {
    const { POST } = await routes.supplements();
    // 时点定在 00:01，保证"今天已经到点"（提醒 tick 会为它生成事件）
    const created = await POST(req("POST", "/api/v1/supplements", { name: "待删补剂", times: ["00:01"] }));
    const { id } = await jsonOf<{ id: number }>(created);

    const { GET: due } = await routes.due();
    const dueBody = await jsonOf<{ events: { type: string; ref_key: string }[] }>(
      await due(req("GET", "/api/v1/reminders/due?channel=feishu")),
    );
    expect(dueBody.events.some((e) => e.type === "supplement" && e.ref_key === `supp:${id}`)).toBe(true);

    const { DELETE } = await routes.supplement();
    expect((await DELETE(req("DELETE", `/api/v1/supplements/${id}`), params({ id: String(id) }))).status).toBe(200);

    const afterBody = await jsonOf<{ events: { type: string; ref_key: string }[] }>(
      await due(req("GET", "/api/v1/reminders/due?channel=feishu")),
    );
    expect(afterBody.events.some((e) => e.ref_key === `supp:${id}`)).toBe(false);
  });
});

describe("规则管理 · 设置与重锚", () => {
  it("放纵餐间隔可改（1~60），GET 回读一致", async () => {
    const { GET, PATCH } = await routes.settings();
    const patched = await PATCH(req("PATCH", "/api/v1/settings", { cheatIntervalDays: 10 }));
    expect(patched.status).toBe(200);
    const body = await jsonOf<{ cheat: { intervalDays: number } }>(patched);
    expect(body.cheat.intervalDays).toBe(10);

    expect((await PATCH(req("PATCH", "/api/v1/settings", { cheatIntervalDays: 0 }))).status).toBe(400);
    expect((await PATCH(req("PATCH", "/api/v1/settings", { cheatIntervalDays: 99 }))).status).toBe(400);

    const read = await jsonOf<{ cheat: { intervalDays: number; anchorDate: string | null } }>(await GET(req("GET", "/api/v1/settings")));
    expect(read.cheat.intervalDays).toBe(10);
    // 复原
    await PATCH(req("PATCH", "/api/v1/settings", { cheatIntervalDays: 8 }));
  });

  it("settings 带上方案的锚点信息；重锚接口按槽位数校验位次", async () => {
    const { GET } = await routes.settings();
    const body = await jsonOf<{
      scheme: { id: string; anchorDate: string; anchorPosition: number; anchorReason: string; templateId: number | null };
    }>(await GET(req("GET", "/api/v1/settings")));
    expect(body.scheme.id).toBe("cycle4");
    expect(typeof body.scheme.anchorReason).toBe("string");
    expect(body.scheme.templateId).not.toBeNull();

    const { POST } = await routes.reanchor();
    expect((await POST(req("POST", "/api/v1/reanchor", { cycle_position: 9 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/v1/reanchor", { cycle_position: 2, reason: "manual" }))).status).toBe(201);
  });
});
