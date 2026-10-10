"use client";

/**
 * 规则管理 · 动作库（v1.2）：动作的增删改 + 器械变体维护（3.1「动作清单必须可编辑」/ 13.14 / FR-49）。
 *
 * 三条口径写死在交互里：
 * - **器械是变体的属性，不是名字的一部分**（踩坑第 31 条）：库里的动作名一律不带器械；
 * - 默认变体 = 动作本身（键为裸动作名），额外的变体用 `equip + 读数语义 + 备注` 表达；
 * - 有历史记录的动作 / 变体**删不得**（历史按 id 引用），接口会如实拒绝并说明原因；
 *   想"不再用"就从方案里移除。
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  qk,
  type ExerciseLibraryRow,
  type ExerciseVariantView,
} from "@/client/api";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Card, Chips, Divider, Empty, Pill, Sheet } from "@/components/ui";

const SEMANTICS_TEXT: Record<string, string> = {
  direct: "读数即负荷",
  ratio_2to1: "滑轮 2:1（实际 = 读数 × 2）",
  assist: "助力（越大越省力，不计容量）",
  band: "弹力带（不计容量）",
};
const LOAD_MODE_TEXT: Record<string, string> = {
  barbell: "杠铃（单侧 ×2 + 杠重）",
  dumbbell: "哑铃双手（单侧 ×2）",
  machine: "器械 / 绳索（读数即总重）",
  bodyweight: "自重（不计容量）",
  single_side: "单臂（单侧 ×1，左右各一遍算 1 组）",
};
const TYPE_TEXT: Record<string, string> = { weight: "重量 × 次数", reps: "自重次数", time: "计时（秒）" };

interface ExerciseForm {
  id: number | null;
  name: string;
  type: "weight" | "reps" | "time";
  equip: string;
  loadMode: "barbell" | "dumbbell" | "machine" | "bodyweight" | "single_side";
  barKg: string;
  base: string;
  /** 动作级默认组间歇（秒，可空 = 用全局默认，FR-52） */
  rest: string;
  sets: number;
  reps: number;
  homeOk: boolean;
  note: string;
  muscles: string[];
}

const EMPTY_FORM: ExerciseForm = {
  id: null,
  name: "",
  type: "weight",
  equip: "杠铃",
  loadMode: "barbell",
  barKg: "20",
  base: "",
  rest: "",
  sets: 4,
  reps: 12,
  homeOk: false,
  note: "",
  muscles: [],
};

export default function ExerciseLibraryPage() {
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState("");
  const [muscle, setMuscle] = useState<string | null>(null);
  const [form, setForm] = useState<ExerciseForm | null>(null);
  const [variantForm, setVariantForm] = useState<{
    exerciseId: number;
    variant: ExerciseVariantView | null;
    equip: string;
    semantics: "direct" | "ratio_2to1" | "assist" | "band";
    label: string;
    base: string;
    /** 这台器械的读数单位（v1.38 / issue #36）："follow" = 跟随全局设置 */
    readUnit: "follow" | "kg" | "lb";
  } | null>(null);

  const { data } = useQuery({
    queryKey: qk.exercises(),
    queryFn: () =>
      api.get<{
        exercises: ExerciseLibraryRow[];
        taxonomy: { muscles: string[]; equips: string[]; semantics: string[]; types: string[]; loadModes: string[] };
      }>("/api/v1/exercises"),
  });
  const muscles = data?.taxonomy.muscles ?? [];
  const exercises = useMemo(() => data?.exercises ?? [], [data?.exercises]);

  // 内置动作库补齐（v1.22）：种子只注入一次（13.12），库扩充后已装过的设备靠这个入口补
  const { data: sync } = useQuery({
    queryKey: qk.exerciseSync(),
    queryFn: () => api.get<{ total: number; missing: string[] }>("/api/v1/exercises/sync"),
  });

  const list = useMemo(() => {
    const kw = keyword.trim();
    return exercises.filter((ex) => {
      if (muscle && !ex.muscles.includes(muscle)) return false;
      if (kw && !ex.name.includes(kw) && !ex.equip.includes(kw) && !ex.muscles.join("").includes(kw)) return false;
      return true;
    });
  }, [exercises, keyword, muscle]);

  const onError = (err: unknown) => toast.show(err instanceof Error ? err.message : "没改成");
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.exercises() });
    await queryClient.invalidateQueries({ queryKey: qk.schemes() });
    await queryClient.invalidateQueries({ queryKey: qk.today() });
  };

  const saveExercise = useMutation({
    mutationFn: async (payload: ExerciseForm) => {
      const body: Record<string, unknown> = {
        name: payload.name.trim(),
        type: payload.type,
        equip: payload.equip,
        load_mode: payload.loadMode,
        bar_kg: payload.loadMode === "barbell" ? (payload.barKg === "" ? null : Number(payload.barKg)) : null,
        base: payload.base === "" ? null : Number(payload.base),
        rest: payload.rest === "" ? null : Number(payload.rest),
        sets: payload.sets,
        reps: payload.reps,
        home_ok: payload.homeOk,
        note: payload.note,
        muscles: payload.muscles,
      };
      return payload.id === null
        ? api.post("/api/v1/exercises", body)
        : api.patch(`/api/v1/exercises/${payload.id}`, body);
    },
    onSuccess: async (_res, payload) => {
      setForm(null);
      toast.show(payload.id === null ? "动作加好了" : "改好了");
      await refresh();
    },
    onError,
  });

  const saveVariant = useMutation({
    mutationFn: async (payload: NonNullable<typeof variantForm>) => {
      const body = {
        equip: payload.equip,
        semantics: payload.semantics,
        label: payload.label,
        base: payload.base === "" ? null : Number(payload.base),
        // "follow" 显式传 null = 跟随全局设置（v1.38）
        read_unit: payload.readUnit === "follow" ? null : payload.readUnit,
      };
      return payload.variant
        ? api.patch(`/api/v1/exercises/${payload.exerciseId}/variants/${payload.variant.id}`, body)
        : api.post(`/api/v1/exercises/${payload.exerciseId}/variants`, body);
    },
    onSuccess: async (_res, payload) => {
      setVariantForm(null);
      toast.show(payload.variant ? "变体改好了 · 之后的记录按新口径算" : "变体加好了 · 训练中就能选到它");
      await refresh();
    },
    onError,
  });

  /** 内置动作库补齐（v1.22）：只新增缺失的，不修改、不删除已有动作 */
  const syncLibrary = useMutation({
    mutationFn: () => api.post<{ added: string[]; kept: number; total: number }>("/api/v1/exercises/sync"),
    onSuccess: async (res) => {
      toast.show(res.added.length > 0 ? `补齐了 ${res.added.length} 个动作` : "已经是最新的了");
      await refresh();
      await queryClient.invalidateQueries({ queryKey: qk.exerciseSync() });
    },
    onError,
  });

  async function handleSyncLibrary() {
    const count = sync?.missing.length ?? 0;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: `把内置库里缺的 ${count} 个动作补进动作库？`,
      body: "只新增缺失的动作：已有的动作、改过的参数与名字都不会被动；补完照常可以改名 / 调参数 / 删除。",
      confirmLabel: "补齐",
    });
    if (ok) syncLibrary.mutate();
  }

  const editing = form ? exercises.find((e) => e.id === form.id) ?? null : null;

  if (!data) {
    return (
      <main className="space-y-3">
        <div className="card h-24 animate-pulse" />
        <div className="card h-40 animate-pulse" />
      </main>
    );
  }

  return (
    <main>
      <div className="mb-2 flex items-center justify-between">
        <button className="tap-ghost text-[13px] text-accent" onClick={() => router.push("/settings")}>
          ← 返回
        </button>
        <div className="muted text-[12.5px]">规则管理 · 动作库（{exercises.length}）</div>
      </div>

      {/* 内置动作库补齐（v1.22）：库扩充后，已装过的设备靠它把缺的动作补上（种子只注入一次，13.12） */}
      {sync && sync.missing.length > 0 && (
        <Card className="mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[14px] font-semibold">内置动作库还差 {sync.missing.length} 个动作</div>
              <div className="muted mt-1 text-[11.5px] leading-relaxed">
                这台设备已收录 {sync.total - sync.missing.length} / {sync.total} 个；补齐只新增缺失的动作，
                不修改、不删除你已有的动作与改动。
              </div>
            </div>
            <button
              type="button"
              className="btn btn-secondary min-h-[40px] shrink-0 px-3 text-[13px]"
              disabled={syncLibrary.isPending}
              onClick={() => void handleSyncLibrary()}
            >
              补齐
            </button>
          </div>
          <details className="mt-2">
            <summary className="muted cursor-pointer text-[11.5px]">看会补哪些</summary>
            <div className="muted mt-1 text-[11.5px] leading-relaxed">{sync.missing.join(" / ")}</div>
          </details>
        </Card>
      )}

      <Card>
        <p className="muted text-[11.5px] leading-relaxed">
          动作名里不带器械（器械是变体的属性）：同一动作换台机器练，用「器械变体」分开记，
          预填 / 常用重量 / PR / 趋势 / 历史分组都按「动作 × 变体」各算各的（13.14）。
        </p>
        <Divider />
        <input
          className="input h-10"
          placeholder="搜动作 / 器械 / 肌群"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="mt-2">
          <Chips
            options={["", ...muscles]}
            value={muscle ?? ""}
            labelOf={(v) => (v === "" ? "全部" : v)}
            onChange={(v) => setMuscle(v === "" ? null : v)}
          />
        </div>
      </Card>

      <div className="sec-title">动作（{list.length}）</div>
      <Card>
        {list.length === 0 && <Empty>没搜到动作 · 换个词或点下面的「新增动作」</Empty>}
        <div className="space-y-1.5">
          {list.map((ex) => (
            <button
              key={ex.id}
              type="button"
              className="w-full rounded-xl border border-border px-3 py-2 text-left"
              onClick={() =>
                setForm({
                  id: ex.id,
                  name: ex.name,
                  type: ex.type,
                  equip: ex.equip,
                  loadMode: ex.loadMode,
                  barKg: ex.barKg === null ? "" : String(ex.barKg),
                  base: ex.baseWeight === null ? "" : String(ex.baseWeight),
                  rest: ex.restSec === null ? "" : String(ex.restSec),
                  sets: ex.defaultSets,
                  reps: ex.defaultReps,
                  homeOk: ex.homeOk,
                  note: ex.note ?? "",
                  muscles: ex.muscles,
                })
              }
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{ex.name}</span>
                  <span className="muted block truncate text-[11.5px]">
                    {ex.muscles.join(" + ")} · {ex.equip} · {TYPE_TEXT[ex.type]} · {ex.defaultSets} × {ex.defaultReps}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {ex.variants.length > 0 && <Pill tone="plain">变体 {ex.variants.length}</Pill>}
                  <span className="muted mt-0.5 block text-[11px]">
                    {ex.setCount > 0 ? `${ex.setCount} 组记录` : ex.templateRefs > 0 ? `用于 ${ex.templateRefs} 处` : "未使用"}
                    {ex.restSec !== null ? ` · 间歇 ${ex.restSec}s` : ""}
                  </span>
                </span>
              </div>
            </button>
          ))}
        </div>
        <button className="btn btn-secondary btn-block mt-3" onClick={() => setForm({ ...EMPTY_FORM })}>
          + 新增动作
        </button>
      </Card>

      {/* —— 动作编辑 —— */}
      <Sheet
        open={form !== null}
        title={form?.id === null ? "新增动作" : `编辑「${form?.name ?? ""}」`}
        onClose={() => setForm(null)}
      >
        {form && (
          <>
            <label className="muted text-[12px]">动作名（不带器械，如「高位下拉」）</label>
            <input
              className="input mt-1 h-10"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />

            <div className="muted mt-3 mb-1.5 text-[12px]">记录形态</div>
            <Chips
              options={["weight", "reps", "time"] as const}
              value={form.type}
              labelOf={(v) => TYPE_TEXT[v]}
              onChange={(v) => setForm({ ...form, type: v })}
            />

            <div className="muted mt-3 mb-1.5 text-[12px]">肌群（细分 15 项，可多选）</div>
            <Chips
              options={muscles}
              multi
              values={form.muscles}
              onChange={(m) =>
                setForm({
                  ...form,
                  muscles: form.muscles.includes(m) ? form.muscles.filter((x) => x !== m) : [...form.muscles, m],
                })
              }
            />

            <div className="muted mt-3 mb-1.5 text-[12px]">默认变体的器械</div>
            <Chips
              options={data?.taxonomy.equips ?? []}
              value={form.equip}
              onChange={(v) => setForm({ ...form, equip: v })}
            />
            <button
              type="button"
              className="tap-ghost muted mt-2 text-[11.5px] underline underline-offset-2"
              onClick={() => {
                // 不确定读数口径就留默认（弹力带 → band、助力器械 → assist、其余 direct），回头再改
                const equip = form.equip;
                setForm({
                  ...form,
                  loadMode: equip === "自重" ? "bodyweight" : form.loadMode === "bodyweight" ? "machine" : form.loadMode,
                });
              }}
            >
              按器械推荐读数口径（点一下）
            </button>

            <div className="muted mt-3 mb-1.5 text-[12px]">重量口径（决定容量怎么折算，13.1）</div>
            <Chips
              options={["barbell", "dumbbell", "machine", "bodyweight", "single_side"] as const}
              value={form.loadMode}
              labelOf={(v) => LOAD_MODE_TEXT[v]}
              onChange={(v) => setForm({ ...form, loadMode: v })}
            />
            {form.loadMode === "barbell" && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[13px]">杠重 kg</span>
                <input
                  className="input h-9 w-20 py-1 text-center"
                  inputMode="decimal"
                  value={form.barKg}
                  onChange={(e) => setForm({ ...form, barKg: e.target.value })}
                />
                <span className="muted text-[11.5px]">默认 20（EZ 杆 10）</span>
              </div>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2">
              <label className="text-[12px]">
                <span className="muted">默认组数</span>
                <input
                  className="input mt-1 h-9 py-1 text-center"
                  inputMode="numeric"
                  value={form.sets}
                  onChange={(e) => setForm({ ...form, sets: Number(e.target.value.replace(/\D/g, "")) || 1 })}
                />
              </label>
              <label className="text-[12px]">
                <span className="muted">{form.type === "time" ? "默认秒数" : "默认次数"}</span>
                <input
                  className="input mt-1 h-9 py-1 text-center"
                  inputMode="numeric"
                  value={form.reps}
                  onChange={(e) => setForm({ ...form, reps: Number(e.target.value.replace(/\D/g, "")) || 1 })}
                />
              </label>
              <label className="text-[12px]">
                <span className="muted">参考重量 kg</span>
                <input
                  className="input mt-1 h-9 py-1 text-center"
                  inputMode="decimal"
                  placeholder="可空"
                  value={form.base}
                  onChange={(e) => setForm({ ...form, base: e.target.value })}
                />
              </label>
            </div>

            <label className="mt-3 block text-[12px]">
              <span className="muted">组间歇 秒（可空 = 用全局默认；FR-52）</span>
              <input
                className="input mt-1 h-9 py-1 text-center"
                inputMode="numeric"
                placeholder="可空 · 例如 120"
                value={form.rest}
                onChange={(e) => setForm({ ...form, rest: e.target.value.replace(/D/g, "") })}
              />
            </label>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-[13px]">居家也能做（自重替代）</span>
              <button
                type="button"
                className={`btn ${form.homeOk ? "btn-primary" : "btn-secondary"} min-h-[36px] px-3 text-[12.5px]`}
                onClick={() => setForm({ ...form, homeOk: !form.homeOk })}
              >
                {form.homeOk ? "是" : "不是"}
              </button>
            </div>

            <label className="muted mt-3 block text-[12px]">备注（选填）</label>
            <input
              className="input mt-1 h-10"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />

            <button
              className="btn btn-primary btn-block mt-4 min-h-[46px]"
              disabled={form.name.trim().length === 0 || form.muscles.length === 0 || saveExercise.isPending}
              onClick={() => saveExercise.mutate(form)}
            >
              {form.id === null ? "加进动作库" : "保存"}
            </button>

            {/* 器械变体（13.14）：同一动作在不同器械上各记各的 */}
            {editing && (
              <>
                <Divider />
                <div className="flex items-center justify-between">
                  <div className="text-[13.5px] font-semibold">器械变体（{editing.variants.length}）</div>
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
                    onClick={() =>
                      setVariantForm({
                        exerciseId: editing.id,
                        variant: null,
                        equip: "器械",
                        semantics: "direct",
                        readUnit: "follow",
                        label: "",
                        base: "",
                      })
                    }
                  >
                    + 加一个变体
                  </button>
                </div>
                <p className="muted mt-1 text-[11.5px]">
                  默认变体就是动作本身（{editing.equip}）；这里只列额外变体。助力 / 弹力带不计容量，2:1 按 ×2 折算。
                </p>
                <div className="mt-2 space-y-1.5">
                  {editing.variants.length === 0 && <div className="muted text-[12.5px]">还没有额外变体</div>}
                  {editing.variants.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-2 rounded-xl border border-border px-2.5 py-1.5">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() =>
                          setVariantForm({
                            exerciseId: editing.id,
                            variant: v,
                            equip: v.equip,
                            semantics: v.semantics,
                          readUnit: v.readUnit ?? "follow",
                            label: v.label,
                            base: v.baseWeight === null ? "" : String(v.baseWeight),
                          })
                        }
                      >
                        <span className="block truncate text-[13.5px]">
                          {v.label || v.equip}
                          {v.semantics !== "direct" && (
                            <span className="muted ml-1.5 text-[11px]">
                              {v.semantics === "ratio_2to1" ? "2:1" : v.semantics === "assist" ? "助力" : "弹力带"}
                            </span>
                          )}
                        </span>
                        <span className="muted text-[11px]">
                          {SEMANTICS_TEXT[v.semantics]}
                          {v.readUnit ? ` · 按 ${v.readUnit} 读` : ""}
                          {v.baseWeight !== null ? ` · 参考 ${v.baseWeight} kg` : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`删掉变体 ${v.label || v.equip}`}
                        className="tap shrink-0 rounded-lg border border-border px-2 text-[12.5px] text-alert"
                        onClick={async () => {
                          if (
                            !(await confirmDialog({
                              title: `删掉变体「${v.label || v.equip}」？`,
                              body: "已经记过组的变体删不掉（读数语义按变体存着）—— 那把它改成对的那台就好。",
                              danger: true,
                              confirmLabel: "删掉",
                            }))
                          ) {
                            return;
                          }
                          await api
                            .del(`/api/v1/exercises/${editing.id}/variants/${v.id}`)
                            .then(() => toast.show("变体删了"))
                            .catch(onError);
                          await refresh();
                        }}
                      >
                        删
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* 删除动作：有历史就不给删（接口也会拦） */}
            {editing && (
              <>
                <Divider />
                <button
                  className="btn btn-danger btn-block"
                  disabled={editing.setCount > 0}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: `从动作库删掉「${editing.name}」？`,
                        body:
                          editing.templateRefs > 0
                            ? `会同步移除各方案槽位里的 ${editing.templateRefs} 处引用；历史记录不受影响。`
                            : "历史记录不受影响。",
                        danger: true,
                        confirmLabel: "删掉",
                      }))
                    ) {
                      return;
                    }
                    await api
                      .del(`/api/v1/exercises/${editing.id}`)
                      .then(() => {
                        toast.show("删了");
                        setForm(null);
                      })
                      .catch(onError);
                    await refresh();
                  }}
                >
                  {editing.setCount > 0 ? `有 ${editing.setCount} 组历史记录，删不掉` : "从动作库删掉"}
                </button>
                {editing.setCount > 0 && (
                  <p className="muted mt-1.5 text-[11.5px]">
                    历史按 id 引用动作，删掉会让记录悬空 —— 不想再练它，从方案槽位里移除就够了。
                  </p>
                )}
              </>
            )}
          </>
        )}
      </Sheet>

      {/* —— 变体编辑 —— */}
      <Sheet
        open={variantForm !== null}
        title={variantForm?.variant ? "编辑器械变体" : "加一个器械变体"}
        onClose={() => setVariantForm(null)}
      >
        {variantForm && (
          <>
            <div className="muted mb-1.5 text-[12px]">器械</div>
            <Chips
              options={data?.taxonomy.equips ?? []}
              value={variantForm.equip}
              onChange={(v) =>
                setVariantForm({
                  ...variantForm,
                  equip: v,
                  // 器械一换，读数语义跟着推荐（手动改过语义的话再点一次即可）
                  semantics: v === "弹力带" ? "band" : v === "助力器械" ? "assist" : variantForm.semantics === "band" || variantForm.semantics === "assist" ? "direct" : variantForm.semantics,
                })
              }
            />
            <div className="muted mt-3 mb-1.5 text-[12px]">读数语义（决定能不能比、算不算容量）</div>
            <Chips
              options={["direct", "ratio_2to1", "assist", "band"] as const}
              value={variantForm.semantics}
              labelOf={(v) => SEMANTICS_TEXT[v]}
              onChange={(v) => setVariantForm({ ...variantForm, semantics: v })}
            />
            <div className="muted mt-3 mb-1.5 text-[12px]">
              这台按什么单位读数（美制器械按磅标；库里一律 kg，只是录入时少算一道）
            </div>
            <Chips
              options={["follow", "kg", "lb"] as const}
              value={variantForm.readUnit}
              labelOf={(v) => (v === "follow" ? "跟随全局设置" : v)}
              onChange={(v) => setVariantForm({ ...variantForm, readUnit: v })}
            />
            <label className="muted mt-3 block text-[12px]">备注（如「靠窗那台」「龙门架 + 下拉杆」）</label>
            <input
              className="input mt-1 h-10"
              value={variantForm.label}
              onChange={(e) => setVariantForm({ ...variantForm, label: e.target.value })}
            />
            <label className="muted mt-3 block text-[12px]">变体参考起始重量 kg（可空；没配就退回动作级）</label>
            <input
              className="input mt-1 h-10"
              inputMode="decimal"
              value={variantForm.base}
              onChange={(e) => setVariantForm({ ...variantForm, base: e.target.value })}
            />
            <button
              className="btn btn-primary btn-block mt-4 min-h-[46px]"
              disabled={saveVariant.isPending}
              onClick={() => saveVariant.mutate(variantForm)}
            >
              {variantForm.variant ? "保存变体" : "加进变体"}
            </button>
          </>
        )}
      </Sheet>
    </main>
  );
}
