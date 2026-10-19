"use client";

/**
 * 规则管理 · 训练排期（v1.2）：分化方案 / 槽位 / 槽位动作清单 / 锚点重锚（FR-21 / FR-23）。
 *
 * 口径出处：
 * - 循环长度 = 槽位数（3.1）；槽位名同方案内唯一（第 6 章）；
 * - 每个槽位两套独立清单：健身房 / 居家自重（13.x、设计说明 §4.2）；
 * - 换方案不改变 3.2 的任何语义，每方案各记一条锚点链；**切回来原样恢复**（设计说明 §4.6），
 *   因此并行期（10.1）不要切方案 —— 页面顶部把这句话写出来。
 * - 调整槽位清单不动历史：`set_log` 与进行中的会话引用的是快照（只影响之后的排期）。
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  qk,
  type ExerciseLibraryRow,
  type SchemeAdmin,
  type SettingsPayload,
} from "@/client/api";
import { useConfirm } from "@/components/confirm";
import { ExercisePicker } from "@/components/exercise-picker";
import { useToast } from "@/components/toast";
import { Card, Chips, Divider, Empty, Pill, Sheet, Stepper } from "@/components/ui";
import { dateInTz } from "@/lib/time";
import { REPS_RANGE } from "@/lib/caliber";

type SlotDraftRow = { exerciseId: number; name: string; type: "weight" | "reps" | "time"; targetSets: number; targetReps: number };

const REASON_TEXT: Record<string, string> = {
  initial: "安装初始锚点",
  manual: "手动重锚",
  pause_resume: "停练后重锚",
  switch_away: "切到别的方案时存下的位次",
  resume: "切回这套方案，按离开时的位次继续",
};

export default function SchemeRulesPage() {
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();

  const [viewId, setViewId] = useState<string | null>(null);
  const [openSlotId, setOpenSlotId] = useState<number | null>(null);
  const [mode, setMode] = useState<"gym" | "home">("gym");
  /** 打开的槽位清单草稿（键 = templateId:场景）：改了要显式保存才写回模板 */
  const [drafts, setDrafts] = useState<Record<string, { rows: SlotDraftRow[]; dirty: boolean }>>({});
  /** 弹层：slot=改槽位；picker=从动作库加动作；reanchor=重锚；newScheme=新建/复制；rename=改名 */
  const [sheet, setSheet] = useState<
    | { kind: "slot"; templateId: number }
    | { kind: "picker"; templateId: number }
    | { kind: "reanchor" }
    | { kind: "newScheme" }
    | { kind: "rename" }
    | { kind: "import" }
    | null
  >(null);
  /** 导入方案（FR-54）：粘贴的 JSON 与（可改的）方案名 */
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [form, setForm] = useState({ name: "", note: "", rest: false, muscles: [] as string[], date: dateInTz(), position: 0 });

  const { data: payload } = useQuery({
    queryKey: qk.schemes(),
    queryFn: () => api.get<{ schemes: SchemeAdmin[]; activeSchemeId: string | null }>("/api/v1/schemes"),
  });
  const { data: lib } = useQuery({
    queryKey: qk.exercises(),
    queryFn: () =>
      api.get<{ exercises: ExerciseLibraryRow[]; taxonomy: { muscles: string[] } }>("/api/v1/exercises"),
  });
  const { data: settings } = useQuery({
    queryKey: qk.settings(),
    queryFn: () => api.get<SettingsPayload>("/api/v1/settings"),
  });

  const schemes = useMemo(() => payload?.schemes ?? [], [payload?.schemes]);
  const current = schemes.find((s) => s.id === (viewId ?? payload?.activeSchemeId)) ?? schemes[0] ?? null;
  const openSlot = current?.slots.find((s) => s.templateId === openSlotId) ?? null;
  const draftKey = openSlot ? `${openSlot.templateId}:${mode}` : "";
  const draftState = drafts[draftKey] ?? null;
  const draft = draftState?.rows ?? null;

  // 打开槽位 / 换场景时把服务端清单灌进草稿（只在第一次灌，之后的编辑以草稿为准）
  useEffect(() => {
    if (!openSlot) return;
    const key = `${openSlot.templateId}:${mode}`;
    const list = (mode === "gym" ? openSlot.gym : openSlot.home).map((ex) => ({
      exerciseId: ex.exerciseId,
      name: ex.name,
      type: ex.type,
      targetSets: ex.targetSets,
      targetReps: ex.targetReps,
    }));
    setDrafts((prev) =>
      prev[key] ? prev : { ...prev, [key]: { rows: list, dirty: false } },
    );
  }, [openSlot, mode]);

  const patchDraft = (mutate: (rows: SlotDraftRow[]) => SlotDraftRow[]) =>
    setDrafts((prev) => {
      const currentDraft = prev[draftKey];
      if (!currentDraft) return prev;
      return { ...prev, [draftKey]: { rows: mutate(currentDraft.rows), dirty: true } };
    });

  const afterRulesChange = async (touchSchedule = true) => {
    await queryClient.invalidateQueries({ queryKey: qk.schemes() });
    if (touchSchedule) {
      await queryClient.invalidateQueries({ queryKey: qk.settings() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    }
  };
  const onError = (err: unknown) => toast.show(err instanceof Error ? err.message : "没改成");

  const run = useMutation({
    mutationFn: async (action: { path: string; method?: "post" | "patch" | "put" | "del"; body?: unknown }) =>
      api[action.method ?? "post"](action.path, action.body),
    onSuccess: () => void afterRulesChange(),
    onError,
  });

  const switchScheme = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/schemes/${id}`, { active: true }),
    onSuccess: async () => {
      toast.show("换方案了 · 排期立刻按新方案算");
      await afterRulesChange();
    },
    onError,
  });

  const createScheme = useMutation({
    mutationFn: (body: { name: string; copy_from?: string }) =>
      api.post<{ id: string }>("/api/v1/schemes", body),
    onSuccess: async (res) => {
      setSheet(null);
      setViewId(res.id);
      toast.show("建好了 · 点「用这套」才会切过去");
      await afterRulesChange();
    },
    onError,
  });

  /** 导出这套（FR-54）：下载一份 JSON，顺手复制到剪贴板（手机之间传更顺手） */
  const exportScheme = async (id: string, name: string) => {
    try {
      const payload = await api.get<Record<string, unknown>>(`/api/v1/schemes/${id}/export`);
      const text = JSON.stringify(payload, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `方案-${name}.json`;
      a.click();
      URL.revokeObjectURL(url);
      try {
        await navigator.clipboard.writeText(text);
        toast.show(`已导出「${name}」· 也复制到剪贴板了`);
      } catch {
        toast.show(`已导出「${name}」· 文件在下载里`);
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "导出失败");
    }
  };

  /** 导入方案（FR-54）：只新建，不覆盖、不切换；动作按名字匹配，缺动作服务端整单拒绝 */
  const importScheme = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(importText) as Record<string, unknown>;
      } catch {
        throw new Error("这段文本不是合法 JSON —— 把导出文件的内容整段粘进来");
      }
      const name = importName.trim();
      return api.post<{ id: string; name: string }>("/api/v1/schemes/import", name ? { ...parsed, name } : parsed);
    },
    onSuccess: async (res) => {
      setSheet(null);
      setViewId(res.id);
      toast.show(`导入成「${res.name}」· 想用就去「用这套」`);
      await afterRulesChange(false);
    },
    onError,
  });

  const saveSlotExercises = useMutation({
    mutationFn: async (args: { templateId: number; list: SlotDraftRow[] }) =>
      api.put(`/api/v1/schemes/${current?.id}/slots/${args.templateId}/exercises`, {
        mode,
        exercises: args.list.map((row) => ({ exercise_id: row.exerciseId, sets: row.targetSets, reps: row.targetReps })),
      }),
    onSuccess: async () => {
      setDrafts((prev) => {
        const currentDraft = prev[draftKey];
        if (!currentDraft) return prev;
        return { ...prev, [draftKey]: { rows: currentDraft.rows, dirty: false } };
      });
      toast.show("清单保存了 · 之后的排期按它来");
      await afterRulesChange();
    },
    onError,
  });

  const reanchor = useMutation({
    mutationFn: (body: { date: string; cycle_position: number }) => api.post("/api/v1/reanchor", body),
    onSuccess: async () => {
      setSheet(null);
      toast.show("已重锚 · 那天起循环从头开始");
      await afterRulesChange();
    },
    onError,
  });

  if (!payload) {
    return (
      <main className="space-y-3">
        <div className="card h-24 animate-pulse" />
        <div className="card h-40 animate-pulse" />
      </main>
    );
  }

  if (schemes.length === 0) {
    return (
      <main className="mt-6">
        <Empty>读不到方案数据（种子未注入？）</Empty>
      </main>
    );
  }

  const moveDraft = (index: number, direction: -1 | 1) => {
    patchDraft((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  return (
    <main>
      <div className="mb-2 flex items-center justify-between">
        <button className="tap-ghost text-[13px] text-accent" onClick={() => router.push("/settings")}>
          ← 返回
        </button>
        <div className="muted text-[12.5px]">规则管理 · 训练排期</div>
      </div>

      <Card>
        <div className="text-[13.5px] font-semibold">当前用的这套</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold">{schemes.find((s) => s.active)?.name ?? "—"}</span>
          <Pill tone="ok">
            循环 {settings?.scheme.cycleLen ?? current?.slots.length ?? 0} 天 · 第{" "}
            {(settings?.scheme.slotIndex ?? 0) + 1} 位
          </Pill>
        </div>
        <p className="muted mt-2 text-[11.5px] leading-relaxed">
          循环长度 = 槽位数；假期不占循环位。**并行期保持默认方案别切** —— 换方案会按「切回来原样恢复」
          给两套方案各补一条锚点，与助手连续推算的循环会错位（需求书 10.1 / 设计说明 §4.6）。
        </p>
      </Card>

      <div className="sec-title">分化方案（换方案 = 显式操作，不动 3.2 的任何语义）</div>
      <Card>
        <div className="flex flex-wrap gap-1.5">
          {schemes.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`tap rounded-lg border px-2.5 text-[12.5px] ${
                s.id === current?.id ? "border-accent bg-accent-soft font-semibold" : "border-border"
              }`}
              onClick={() => {
                setViewId(s.id);
                setOpenSlotId(null);
                setMode("gym");
              }}
            >
              {s.name}
              {s.active ? " · 在用" : ""}
            </button>
          ))}
        </div>
        <Divider />
        {current && (
          <>
            <div className="text-[13.5px] leading-relaxed">{current.note || "（这套方案没有说明）"}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {current.slots.map((s, i) => (
                <span key={s.templateId} className="flex items-center gap-1.5">
                  {i > 0 && <span className="muted text-[11px]">→</span>}
                  <span className="rounded-lg border border-border px-2 py-0.5 text-[12px]">
                    {s.rest ? "休" : s.label}
                  </span>
                </span>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                className={`btn ${current.active ? "btn-secondary" : "btn-primary"} min-h-[42px] text-[13.5px]`}
                disabled={current.active || switchScheme.isPending}
                onClick={() => switchScheme.mutate(current.id)}
              >
                {current.active ? "正在用这套" : "用这套"}
              </button>
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                onClick={() => {
                  setForm({ ...form, name: `${current.name} 副本` });
                  setSheet({ kind: "newScheme" });
                }}
              >
                复制一份
              </button>
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                onClick={() => {
                  setForm({ ...form, name: current.name, note: current.note });
                  setSheet({ kind: "rename" });
                }}
              >
                改名 / 改说明
              </button>
              {/* FR-54：导出/导入 —— 换设备或重装时把方案带走 */}
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                onClick={() => void exportScheme(current.id, current.name)}
              >
                导出这套（JSON）
              </button>
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                onClick={() => {
                  setImportText("");
                  setImportName("");
                  setSheet({ kind: "import" });
                }}
              >
                导入方案（JSON）
              </button>
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                disabled={current.active}
                onClick={async () => {
                  if (
                    !(await confirmDialog({
                      title: `删掉方案「${current.name}」？`,
                      body: "这套的槽位、清单与锚点历史一起删掉；历史训练记录不受影响。",
                      danger: true,
                      confirmLabel: "删掉",
                    }))
                  ) {
                    return;
                  }
                  await api.del(`/api/v1/schemes/${current.id}`).catch(onError);
                  setViewId(null);
                  await afterRulesChange();
                }}
              >
                删掉这套
              </button>
            </div>
            {!current.active && <p className="muted mt-2 text-[11.5px]">不是当前的方案：可以先改好，再点「用这套」。</p>}
          </>
        )}
      </Card>

      <div className="sec-title">
        槽位（{current?.slots.length ?? 0} 个 · 循环长度就是它{current?.active ? "" : " · 改的是「" + (current?.name ?? "") + "」"}）
      </div>
      <Card>
        <div className="space-y-2">
          {current?.slots.map((slot, index) => (
            <div key={slot.templateId} className="rounded-xl border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenSlotId(openSlotId === slot.templateId ? null : slot.templateId)}
                >
                  <span className="flex items-center gap-2">
                    <span className="muted text-[11.5px]">{index + 1}</span>
                    <span className="truncate text-[14px] font-medium">{slot.label}</span>
                    {slot.rest && <Pill tone="plain">休</Pill>}
                  </span>
                  <span className="muted mt-0.5 block truncate text-[11.5px]">
                    {slot.rest ? "不训练" : slot.muscles.length > 0 ? slot.muscles.join(" + ") : "未标肌群"}
                    {" · "}
                    {slot.gym.length} 个动作 / 居家 {slot.home.length} 个
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-label={`把 ${slot.label} 往上挪`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                    onClick={() =>
                      run.mutate({ path: `/api/v1/schemes/${current?.id}/slots/${slot.templateId}`, method: "patch", body: { move: "up" } })
                    }
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`把 ${slot.label} 往下挪`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                    onClick={() =>
                      run.mutate({ path: `/api/v1/schemes/${current?.id}/slots/${slot.templateId}`, method: "patch", body: { move: "down" } })
                    }
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2 text-[12.5px]"
                    onClick={() => {
                      setForm({ ...form, name: slot.label, rest: slot.rest, muscles: slot.muscles });
                      setSheet({ kind: "slot", templateId: slot.templateId });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    aria-label={`删掉槽位 ${slot.label}`}
                    className="tap rounded-lg border border-border px-2 text-[12.5px] text-alert"
                    onClick={async () => {
                      if (
                        !(await confirmDialog({
                          title: `删掉槽位「${slot.label}」？`,
                          body: "循环长度会少一天；已经练过的记录不受影响。",
                          danger: true,
                          confirmLabel: "删掉",
                        }))
                      ) {
                        return;
                      }
                      run.mutate({ path: `/api/v1/schemes/${current?.id}/slots/${slot.templateId}`, method: "del" });
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* 展开：这个槽位的两套动作清单（健身房 / 居家自重各自独立） */}
              {openSlotId === slot.templateId && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="mb-2 flex gap-1 rounded-xl bg-bg p-1">
                    {(
                      [
                        ["gym", "健身房"],
                        ["home", "居家自重"],
                      ] as ["gym" | "home", string][]
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`tap flex-1 rounded-lg text-[12.5px] font-medium ${mode === key ? "bg-card shadow-sm" : "text-muted"}`}
                        onClick={() => setMode(key)}
                      >
                        {label}（{(key === "gym" ? slot.gym : slot.home).length}）
                      </button>
                    ))}
                  </div>

                  {(draft ?? []).length === 0 && <Empty>这套清单还是空的 · 点下面加动作</Empty>}
                  <div className="space-y-1.5">
                    {(draft ?? []).map((row, index) => (
                      /* 动作行：名称/参数独占一行，控件组整体换行（issue #69 / 第 12 章第 39 条）。
                         右列控件固定 308px（Stepper 116×2 + ▲▼ 32×2 + gap），超过 390px 下的行内容宽 286px，
                         `nowrap + 左列只 min-w-0 + 右列 shrink-0` 会把动作名压成一字一行；不许缩小点区（第 38 条 ≥32px）。 */
                      <div
                        key={row.exerciseId}
                        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 rounded-xl border border-border px-2.5 py-1.5"
                      >
                        <button
                          type="button"
                          className="min-w-0 grow basis-full text-left"
                          onClick={() => patchDraft((rows) => rows.filter((r) => r.exerciseId !== row.exerciseId))}
                        >
                          <span className="block truncate text-[13.5px]">{row.name}</span>
                          <span className="muted text-[11px] whitespace-nowrap">
                            {row.targetSets} × {row.targetReps}
                            {row.type === "time" ? " 秒" : " 次"} · 点名称移除
                          </span>
                        </button>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Stepper
                            label="组"
                            value={row.targetSets}
                            min={1}
                            max={20}
                            onChange={(v) =>
                              patchDraft((rows) =>
                                rows.map((r) => (r.exerciseId === row.exerciseId ? { ...r, targetSets: v } : r)),
                              )
                            }
                          />
                          <Stepper
                            label={row.type === "time" ? "秒" : "次"}
                            value={row.targetReps}
                            min={1}
                            max={REPS_RANGE.max}
                            onChange={(v) =>
                              patchDraft((rows) =>
                                rows.map((r) => (r.exerciseId === row.exerciseId ? { ...r, targetReps: v } : r)),
                              )
                            }
                          />
                          {/* ▲▼ 成一小组：换行时两个箭头一起落到下一行，不拆开 */}
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`把 ${row.name} 往上挪`}
                              className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                              onClick={() => moveDraft(index, -1)}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              aria-label={`把 ${row.name} 往下挪`}
                              className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                              onClick={() => moveDraft(index, 1)}
                            >
                              ▼
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      className="btn btn-secondary min-h-[42px] text-[13.5px]"
                      onClick={() => setSheet({ kind: "picker", templateId: slot.templateId })}
                    >
                      + 从动作库加动作
                    </button>
                    <button
                      className="btn btn-primary min-h-[42px] text-[13.5px]"
                      disabled={!draftState?.dirty || saveSlotExercises.isPending}
                      onClick={() => saveSlotExercises.mutate({ templateId: slot.templateId, list: draft ?? [] })}
                    >
                      {draftState?.dirty ? `保存这套清单（${draft?.length ?? 0}）` : "已保存"}
                    </button>
                  </div>
                  <p className="muted mt-2 text-[11.5px]">
                    改清单只影响之后的排期：历史记录与进行中的会话各带自己的快照。
                    {draftState?.dirty ? " 记得点「保存这套清单」。" : " 没有未保存的改动。"}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        <button
          className="btn btn-secondary btn-block mt-3"
          onClick={() => {
            setForm({ ...form, name: "", rest: false, muscles: [] });
            setSheet({ kind: "slot", templateId: -1 });
          }}
        >
          + 加一个槽位
        </button>
      </Card>

      <div className="sec-title">锚点与重锚（FR-23：暂停后回来，先问再改，禁止自动重锚）</div>
      <Card>
        <div className="text-[13.5px]">
          当前锚点：<span className="font-semibold">{current?.anchor?.date ?? "—"}</span> · 第{" "}
          {(current?.anchor?.position ?? 0) + 1} 位
          <span className="muted ml-2 text-[12px]">{REASON_TEXT[current?.anchor?.reason ?? "initial"] ?? current?.anchor?.reason}</span>
        </div>
        <p className="muted mt-1.5 text-[11.5px] leading-relaxed">
          重锚 = 从某天起把循环拨回指定槽位（只追加一条锚历史，不改旧记录）。停练后回来用它，不要用「今天不练」去凑。
        </p>
        <button
          className="btn btn-secondary btn-block mt-3"
          onClick={() => {
            setForm({ ...form, date: dateInTz(), position: 0 });
            setSheet({ kind: "reanchor" });
          }}
        >
          以某天重锚…
        </button>
      </Card>

      <p className="muted mt-4 text-center text-[11.5px]">
        <button className="tap-ghost leading-5 text-accent underline underline-offset-2" onClick={() => router.push("/settings/exercises")}>
          动作库与器械变体
        </button>
        {" · "}
        补剂与提醒时间在「我的」页
      </p>

      {/* —— 弹层 —— */}

      <Sheet
        open={sheet?.kind === "slot"}
        title={sheet?.kind === "slot" && sheet.templateId === -1 ? "加一个槽位" : "编辑槽位"}
        onClose={() => setSheet(null)}
      >
        <label className="muted text-[12px]">槽位名（就是记录里的「部位」，同一方案内唯一）</label>
        <input
          className="input mt-1 h-10"
          placeholder="如：推 / 拉 / 腿 / 休"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[13.5px]">是「休」日（不训练，但照样占一个循环位）</span>
          <button
            type="button"
            className={`btn ${form.rest ? "btn-primary" : "btn-secondary"} min-h-[36px] px-3 text-[12.5px]`}
            onClick={() => setForm({ ...form, rest: !form.rest })}
          >
            {form.rest ? "是" : "不是"}
          </button>
        </div>
        <div className="mt-3">
          <div className="muted mb-1.5 text-[12px]">肌群（细分 15 项，可多选；恢复度与统计按它解析）</div>
          <Chips
            options={lib?.taxonomy.muscles ?? []}
            multi
            values={form.muscles}
            onChange={(m) =>
              setForm({
                ...form,
                muscles: form.muscles.includes(m) ? form.muscles.filter((x) => x !== m) : [...form.muscles, m],
              })
            }
          />
        </div>
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={form.name.trim().length === 0}
          onClick={() => {
            const body = { name: form.name.trim(), rest: form.rest, muscles: form.muscles };
            if (sheet?.kind === "slot" && sheet.templateId === -1) {
              run.mutate({ path: `/api/v1/schemes/${current?.id}/slots`, body });
            } else if (sheet?.kind === "slot") {
              run.mutate({ path: `/api/v1/schemes/${current?.id}/slots/${sheet.templateId}`, method: "patch", body });
            }
            setSheet(null);
          }}
        >
          保存
        </button>
      </Sheet>

      <Sheet open={sheet?.kind === "picker"} title="从动作库加动作" onClose={() => setSheet(null)}>
        <ExercisePicker
          open={sheet?.kind === "picker"}
          title=""
          exercises={lib?.exercises ?? []}
          muscles={lib?.taxonomy.muscles ?? []}
          prefer={openSlot?.muscles ?? []}
          excludeIds={(draft ?? []).map((r) => r.exerciseId)}
          onClose={() => setSheet(null)}
          onPick={(picked) => {
            patchDraft((rows) => [
              ...rows,
              {
                exerciseId: picked.id,
                name: picked.name,
                type: picked.type,
                targetSets: picked.sets,
                targetReps: picked.reps,
              },
            ]);
            setSheet(null);
            toast.show(`加了「${picked.name}」· 记得点「保存这套清单」`);
          }}
        />
      </Sheet>

      <Sheet open={sheet?.kind === "reanchor"} title="以某天重锚" onClose={() => setSheet(null)}>
        <p className="muted text-[12px] leading-relaxed">
          只追加一条锚历史；欠账按口径清零（暂停期不产生欠账）。选「从哪个槽位开始」，那天起按这个顺序走。
        </p>
        <label className="muted mt-3 block text-[12px]">从哪一天起</label>
        <input
          className="input mt-1 h-10"
          type="date"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
        />
        <div className="muted mt-3 mb-1.5 text-[12px]">从哪个槽位开始</div>
        <Chips
          options={(current?.slots ?? []).map((s) => String(s.position))}
          value={String(form.position)}
          labelOf={(v) => {
            const slot = current?.slots.find((s) => String(s.position) === v);
            return slot ? `${slot.position + 1}. ${slot.label}` : v;
          }}
          onChange={(v) => setForm({ ...form, position: Number(v) })}
        />
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={reanchor.isPending}
          onClick={() => reanchor.mutate({ date: form.date, cycle_position: form.position })}
        >
          重锚（以 {form.date} 为第 {form.position + 1} 位）
        </button>
      </Sheet>

      <Sheet open={sheet?.kind === "newScheme"} title="新建方案（复制现在这套）" onClose={() => setSheet(null)}>        <p className="muted text-[12px]">复制槽位与两套动作清单，改个名字就能改成自己的分化；之后点「用这套」才生效。</p>
        <input
          className="input mt-3 h-10"
          placeholder="方案名"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={form.name.trim().length === 0 || createScheme.isPending}
          onClick={() => createScheme.mutate({ name: form.name.trim(), copy_from: current?.id })}
        >
          建好并查看
        </button>
      </Sheet>

      <Sheet open={sheet?.kind === "rename"} title="改方案名 / 说明" onClose={() => setSheet(null)}>
        <input
          className="input h-10"
          placeholder="方案名"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <textarea
          className="input mt-2 min-h-[80px] py-2"
          placeholder="说明（如：每个肌群约每 4 天轮到一次）"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={form.name.trim().length === 0}
          onClick={() => {
            run.mutate({ path: `/api/v1/schemes/${current?.id}`, method: "patch", body: { name: form.name.trim(), note: form.note } });
            setSheet(null);
          }}
        >
          保存
        </button>
      </Sheet>

      {/* 导入方案（FR-54）：粘贴导出文件的内容；动作按名字匹配，缺动作会被服务端列出来 */}
      <Sheet open={sheet?.kind === "import"} title="导入方案（JSON）" onClose={() => setSheet(null)}>
        <p className="muted text-[12px] leading-relaxed">
          把导出文件的内容整段粘进来。导入只会<span className="font-semibold">新建</span>一套方案（不覆盖、不自动切换）；
          动作按名字匹配，库里没有的动作会被列出来、整单拒绝。
        </p>
        <label className="muted mt-3 mb-1.5 block text-[12px]">方案名（可改，导入后重名会被拒）</label>
        <input
          className="input h-10"
          placeholder="方案名"
          value={importName}
          onChange={(e) => setImportName(e.target.value)}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="muted text-[12px]">或者直接选文件</span>
          <input
            type="file"
            accept="application/json,.json"
            className="text-[12px]"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              setImportText(text);
              try {
                const parsed = JSON.parse(text) as { name?: string };
                if (parsed.name) setImportName(parsed.name);
              } catch {
                // 解析失败留给提交时报错（这里只填文本）
              }
            }}
          />
        </div>
        <textarea
          className="input mt-2 min-h-[140px] py-2 font-mono text-[11.5px]"
          placeholder='{ "kind": "fitness-app.scheme", "version": 1, "name": "…", "slots": [ … ] }'
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={importText.trim().length === 0 || importScheme.isPending}
          onClick={() => importScheme.mutate()}
        >
          {importScheme.isPending ? "导入中…" : "导入成新方案"}
        </button>
      </Sheet>
    </main>
  );
}

