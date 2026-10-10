"use client";

import { Suspense } from "react";

/**
 * 开练前的计划页（FR-6 / FR-10 / FR-4 换部位 / 交互设计说明 §4.9）。
 *
 * 全部点选、不用打字：勾掉今天不做的动作、从动作库加动作、调顺序、调本次目标组数次数、换场景
 * （健身房 / 居家自重）、**换部位**（今天改练别的 → 用另一个模板，只影响今天）。
 * 调整**只影响本次会话**（开始后存进会话快照）；
 * 「把这套存回模板」是唯一的例外 —— 它显式改当前槽位的清单（FR-21）。
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  api,
  qk,
  type ExerciseLibraryRow,
  type SchemeAdmin,
  type SettingsPayload,
  type TodayPayload,
} from "@/client/api";
import { ExercisePicker } from "@/components/exercise-picker";
import { PartPicker } from "@/components/part-picker";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Card, Empty, SectionTitle, Sheet, Stepper } from "@/components/ui";
import { formatWeight } from "@/lib/units";

interface PlanRow {
  exerciseId: number;
  name: string;
  type: "weight" | "reps" | "time";
  muscles: string[];
  targetSets: number;
  targetReps: number;
  selected: boolean;
  /** 「照上次填」预览（FR-7）：开练前就知道上次用什么重量 */
  lastLabel: string | null;
}

/** 本机计划草稿（v1.18）：计划页不落库，调整存在这里，刷新 / 返回再进来还在 */
interface PlanDraft {
  signature: string;
  rows: PlanRow[];
  restTarget: number;
  savedAt: number;
}

function readPlanDraft(key: string): PlanDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PlanDraft) : null;
  } catch {
    return null;
  }
}

function writePlanDraft(key: string, draft: PlanDraft) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // 存不下就算了（隐私模式 / 配额满）：不影响开练
  }
}

function clearPlanDraft(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

/** 服务端清单 → 本地行（含「照上次填」预览，FR-7） */
function buildRows(exercises: TodayPayload["exercises"], unit: "kg" | "lb"): PlanRow[] {
  return exercises.map((ex) => {
    const last = ex.lastByVariant.default;
    return {
      exerciseId: ex.exerciseId,
      name: ex.name,
      type: ex.type,
      muscles: ex.muscles,
      targetSets: ex.targetSets,
      targetReps: ex.targetReps,
      selected: true,
      lastLabel: last?.weightKg
        ? `上次 ${formatWeight(last.weightKg, unit)}`
        : last?.durationSec
          ? `上次 ${last.durationSec} 秒`
          : last?.reps
            ? `上次 ${last.reps} 次`
            : null,
    };
  });
}

function SessionPlanPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [mode, setMode] = useState<"gym" | "home">(params.get("mode") === "home" ? "home" : "gym");
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [restTarget, setRestTarget] = useState(90);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 换部位（FR-4）：今天临时改练别的槽位 —— 只影响今天，不重锚循环 */
  const [partOpen, setPartOpen] = useState(false);
  /** 停留提示（v1.18）：改完这套多久没再动 */
  const [touchedAt, setTouchedAt] = useState(() => Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  // FR-13 补记：?date=YYYY-MM-DD（≤ 今天）→ 计划与落库都归那天
  const backfillDate = params.get("date") ?? "";
  // FR-4 改练其他部位：?part=<槽位 id> → 今天用那个槽位的清单
  const partParam = params.get("part") ?? "";
  /** 计划草稿的键（v1.18：草稿存在本机，不落库、不设超时） */
  const draftKey = `fitness-plan-draft:${backfillDate || "today"}:${partParam || "auto"}:${mode}`;
  // 组间歇默认值来自设置（rest_default_sec）；默认三档之外的值仍从 90s 起步，用户可即时换档
  const { data: settings } = useQuery({
    queryKey: qk.settings(),
    queryFn: () => api.get<SettingsPayload>("/api/v1/settings"),
  });
  useEffect(() => {
    if (settings && [60, 90, 120].includes(settings.restDefaultSec)) {
      setRestTarget(settings.restDefaultSec);
    }
  }, [settings]);

  const { data, isLoading } = useQuery({
    queryKey: [...qk.today(mode), backfillDate, partParam],
    queryFn: () =>
      api.get<TodayPayload>(
        `/api/v1/today?mode=${mode}${backfillDate ? `&date=${backfillDate}` : ""}${partParam ? `&part=${partParam}` : ""}`,
      ),
  });

  // 动作库只在打开选择器时才取（91 条不必随首屏加载）
  const { data: lib } = useQuery({
    queryKey: qk.exercises(),
    queryFn: () =>
      api.get<{ exercises: ExerciseLibraryRow[]; taxonomy: { muscles: string[] } }>("/api/v1/exercises"),
    enabled: pickerOpen,
  });

  // 服务端清单 → 本地行（只在**清单本身变了**时重置：后台重新取数不该把这一屏的调整冲掉）
  const unit = data?.unit ?? "kg";
  const serverSignature = data
    ? `${data.date}|${mode}|${data.part}|${data.exercises.map((e) => `${e.exerciseId}:${e.targetSets}:${e.targetReps}`).join(",")}`
    : "";
  useEffect(() => {
    if (!data) return;
    // 本机草稿优先（v1.18）：刷新 / 返回再进来，勾选与目标还在（签名一致才认，清单变了就作废）
    const stored = readPlanDraft(draftKey);
    if (stored && stored.signature === serverSignature) {
      setRows(stored.rows);
      setRestTarget(stored.restTarget);
      setTouchedAt(stored.savedAt);
      return;
    }
    setRows(buildRows(data.exercises, unit));
    // 依赖只写清单签名与单位：data 每次重新取数都是新对象，写进去会把用户的调整冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSignature, unit]);

  // 草稿边改边落本机（计划页不落库：没点「开始」就没有会话，也就没有"超时丢弃"这回事）
  useEffect(() => {
    if (!rows || !serverSignature) return;
    writePlanDraft(draftKey, { signature: serverSignature, rows, restTarget, savedAt: Date.now() });
    setTouchedAt(Date.now());
  }, [rows, restTarget, draftKey, serverSignature]);

  // 停留久了给一句温和提示（不自动丢、不自动开始）；每分钟对一次表
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const idleMinutes = Math.floor((nowTick - touchedAt) / 60_000);
  const idle = idleMinutes >= 15;

  const plan = rows ?? [];
  const selected = plan.filter((p) => p.selected);
  const totalSets = selected.reduce((sum, p) => sum + p.targetSets, 0);
  /**
   * 加练（13.17）：今天本来是非训练日（循环位「休」/ 假期）却要开练 = 加练 ——
   * 练完循环按练的部位顺延（今天没休的休息顺延到明天）。
   * 判据用 `isTrainingDay`（看的是**循环**，不受 ?part= 覆盖影响）；
   * 补记（?date=）不算：过去那天真练了只是记录，不许回头改写排期。
   */
  const isExtra = !backfillDate && data?.isTrainingDay === false;

  const patchRow = (exerciseId: number, patch: Partial<PlanRow>) =>
    setRows((prev) => (prev ?? []).map((row) => (row.exerciseId === exerciseId ? { ...row, ...patch } : row)));

  const moveRow = (index: number, direction: -1 | 1) =>
    setRows((prev) => {
      const list = [...(prev ?? [])];
      const target = index + direction;
      if (target < 0 || target >= list.length) return list;
      [list[index], list[target]] = [list[target], list[index]];
      return list;
    });

  const startMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        client_id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        part: data?.part ?? "",
        mode,
        status: "doing" as const,
        started_at: new Date().toISOString(),
        // 补记：显式指定日期（第 7 章允许；不指定则按 13.3 归 started_at 当天）
        ...(backfillDate ? { date: backfillDate } : {}),
        // 加练（13.17）：非训练日开练 → 走位点顺延循环（服务端只认"今天 + 非训练日 + 非休槽位"）
        ...(isExtra ? { extra: true } : {}),
        // 槽位 id（换部位后记的就是那个槽位；只作追溯用，不动锚点）
        ...(data?.scheme.templateId ? { template_id: data.scheme.templateId } : {}),
        rest_target_sec: restTarget,
        plan_snapshot: { mode, exercises: selected },
        exercises: selected.map((p, index) => ({
          exercise_id: p.exerciseId,
          order_no: index,
          target_sets: p.targetSets,
          target_reps: p.targetReps,
        })),
      };
      return api.post<{ id: number; created: boolean }>("/api/v1/sessions", payload);
    },
    onSuccess: (res) => {
      clearPlanDraft(draftKey);
      router.replace(`/session/${res.id}`);
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "开始失败"),
  });

  // FR-21：把这套清单存回当前槽位（显式操作；只动这一套场景的清单）
  const saveTemplate = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/schemes/${data?.scheme.id}/slots/${data?.scheme.templateId}/exercises`, {
        mode,
        exercises: selected.map((p) => ({ exercise_id: p.exerciseId, sets: p.targetSets, reps: p.targetReps })),
      }),
    onSuccess: () => {
      toast.show("存回模板了 · 之后的排期按这套来");
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "存模板失败"),
  });

  /** 换部位（FR-4）：只改 URL 上的 ?part= —— 今天用那个槽位的清单，锚点与循环都不动 */
  const pickPart = (slot: SchemeAdmin["slots"][number]) => {
    setPartOpen(false);
    if (slot.label === data?.part) return;
    const next = new URLSearchParams(params.toString());
    next.set("part", String(slot.templateId));
    next.set("mode", mode);
    router.replace(`/session/plan?${next.toString()}`);
    toast.show(`今天改练「${slot.label}」· 只影响今天，循环没动`);
  };

  if (isLoading) return <div className="card mt-10 h-40 animate-pulse" />;
  if (!data) return <Empty>读不到今天的计划</Empty>;

  // 休日 / 节假日的拦路只对"今天"生效：补记休日练过的一场是合法的（出勤事实就是出勤）；
  // 显式换了部位（part=）也一样 —— 今天想练就练，别拿排期拦他
  if ((data.holiday?.type === "holiday" || data.isRestDay) && !backfillDate && !partParam) {
    return (
      <main className="mt-6">
        <Card>
          <div className="text-[15px] font-semibold">
            {data.holiday?.type === "holiday" ? `${data.holiday.name}，今天不练` : "循环位是「休」，今天不练"}
          </div>
          <div className="muted mt-2 text-[12.5px]">
            想练也可以：选个部位就能开练 —— 这是「加练」：练完循环按你练的部位顺延，今天没休的「休」顺延到明天。
          </div>
          <button className="btn btn-primary btn-block mt-4" onClick={() => setPartOpen(true)}>
            改为加练 · 选部位
          </button>
          <button className="btn btn-secondary btn-block mt-2" onClick={() => router.push("/")}>
            回今日
          </button>
        </Card>
        <PartPicker
          open={partOpen}
          mode={mode}
          currentPart={data.part}
          onClose={() => setPartOpen(false)}
          onPick={pickPart}
        />
      </main>
    );
  }

  // 选择器把「今天这套已经练到的肌群」排在前面（同肌群的替代动作最顺手）
  const preferMuscles = [...new Set(plan.flatMap((p) => p.muscles))];

  return (
    <main>
      <div className="mb-2 flex items-center justify-between">
        <button className="tap-ghost text-[13px] text-accent" onClick={() => router.push(backfillDate ? "/history" : "/")}>
          ← 返回
        </button>
        <div className="muted text-[12.5px]">已选 {selected.length} 个动作 / {totalSets} 组</div>
      </div>

      {/* 停留提示（v1.18）：计划页不落库、也不会静默丢弃 —— 只有一句陈述，两个明确的选择 */}
      {idle && (
        <div className="mb-3 rounded-xl border border-border bg-card px-3 py-2 text-[12.5px] leading-relaxed">
          停了 {idleMinutes} 分钟了。这套调整还在（存在这台手机上），随时点「开始训练」；
          不想练就退出去，下次进来照旧。{" "}
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            onClick={() => {
              clearPlanDraft(draftKey);
              setRows(buildRows(data.exercises, unit));
              setTouchedAt(Date.now());
              toast.show("这套调整丢了 · 按模板重新给了一份");
            }}
          >
            丢弃这套调整
          </button>
        </div>
      )}

      <Card>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="muted text-[12px]">
              {backfillDate ? `补记 · ${backfillDate.slice(5).replace("-", "月")}日` : isExtra ? "加练 · 今天本来不练" : "今天练"}
            </div>
            <div className="text-xl font-bold">{data.part}</div>
          </div>
          <div className="flex gap-1 rounded-xl bg-bg p-1">
            {(["gym", "home"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`tap rounded-lg px-3 text-[13px] font-medium ${
                  mode === m ? "bg-card shadow-sm" : "text-muted"
                }`}
                onClick={() => setMode(m)}
              >
                {m === "gym" ? "健身房" : "居家自重"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          {/* FR-4：今天改练别的部位（用另一个槽位的清单）——循环与锚点都不动 */}
          <button
            type="button"
            className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
            onClick={() => setPartOpen(true)}
          >
            换部位
          </button>
          {isExtra ? (
            <span className="muted text-[11.5px]">加练 · 练完循环按你练的部位顺延（今天没休的「休」顺延到明天）</span>
          ) : (
            data.partOverride && (
              <span className="muted text-[11.5px]">今天临时改练 · 循环没动，下次照原排期</span>
            )
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <span className="muted">组间歇</span>
          {[60, 90, 120].map((sec) => (
            <button
              key={sec}
              type="button"
              className={`tap rounded-lg px-2.5 ${restTarget === sec ? "bg-accent text-accent-fg" : "border border-border"}`}
              onClick={() => setRestTarget(sec)}
            >
              {sec}s
            </button>
          ))}
        </div>
      </Card>

      <SectionTitle>动作清单（点一下就能改，不打字）</SectionTitle>
      <Card>
        {plan.length === 0 ? (
          <Empty>这个槽位还没有动作清单 · 用下面的「+ 从动作库加一个」临时加，或去规则管理改模板</Empty>
        ) : (
          <div className="space-y-3">
            {plan.map((p, index) => (
              <div key={p.exerciseId} className={p.selected ? "" : "opacity-45"}>
                {/* 名字一行到底（窄屏也别截成「引体…」），排序/移出靠右；组数次数放下一行 */}
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    onClick={() => patchRow(p.exerciseId, { selected: !p.selected })}
                  >
                    <span
                      aria-hidden
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                        p.selected ? "border-accent bg-accent text-accent-fg" : "border-border"
                      }`}
                    >
                      {p.selected ? "✓" : ""}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium leading-snug">{p.name}</span>
                      <span className="muted mt-0.5 block text-[11.5px] leading-snug">
                        {p.muscles.join(" + ")}
                        {p.lastLabel ? ` · ${p.lastLabel}` : ""}
                      </span>
                    </span>
                  </button>
                  {/* FR-10：调顺序 / 移出今天（只影响本次会话） */}
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`把 ${p.name} 往上挪`}
                      className="grid h-9 w-9 place-items-center rounded-lg border border-border text-[11px]"
                      onClick={() => moveRow(index, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`把 ${p.name} 往下挪`}
                      className="grid h-9 w-9 place-items-center rounded-lg border border-border text-[11px]"
                      onClick={() => moveRow(index, 1)}
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      aria-label={`从今天移除 ${p.name}`}
                      className="grid h-9 w-9 place-items-center rounded-lg border border-border text-[11px] text-alert"
                      onClick={() => setRows((prev) => (prev ?? []).filter((r) => r.exerciseId !== p.exerciseId))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-7">
                  <Stepper
                    label="组"
                    value={p.targetSets}
                    onChange={(v) => patchRow(p.exerciseId, { targetSets: Math.max(1, v) })}
                  />
                  <Stepper
                    label={p.type === "time" ? "秒" : "次"}
                    value={p.targetReps}
                    onChange={(v) => patchRow(p.exerciseId, { targetReps: Math.max(1, v) })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="btn btn-secondary btn-block mt-3 min-h-[42px] text-[13.5px]"
          onClick={() => setPickerOpen(true)}
        >
          + 从动作库加一个
        </button>
      </Card>

      <div className="mt-4 space-y-2">
        <button
          className="btn btn-primary btn-block min-h-[56px] text-[16px]"
          disabled={selected.length === 0 || startMutation.isPending}
          onClick={() => startMutation.mutate()}
        >
          {startMutation.isPending
            ? "开始中…"
            : `${backfillDate ? "开始补记" : "开始训练"} · ${totalSets} 组`}
        </button>
        <button
          className="btn btn-secondary btn-block"
          disabled={selected.length === 0 || !data.scheme.templateId || saveTemplate.isPending}
          onClick={async () => {
            if (
              await confirmDialog({
                title: "把这套清单存回模板？",
                body: `会改「${data.scheme.name}」里「${data.part}」这个槽位的${mode === "gym" ? "健身房" : "居家自重"}清单（${selected.length} 个动作，含目标组数次数），之后的排期都按它来。`,
                confirmLabel: "存回模板",
              })
            ) {
              saveTemplate.mutate();
            }
          }}
        >
          把这套存回模板
        </button>
        <button className="btn btn-secondary btn-block" onClick={() => router.push("/")}>
          取消
        </button>
        <p className="muted text-center text-[11.5px]">
          调整只影响本次会话（开始后存进快照）；「存回模板」才会改槽位清单
        </p>
      </div>

      <Sheet open={pickerOpen} title="从动作库加一个" onClose={() => setPickerOpen(false)}>
        <ExercisePicker
          open={pickerOpen}
          title=""
          exercises={lib?.exercises ?? []}
          muscles={lib?.taxonomy.muscles ?? []}
          prefer={preferMuscles}
          excludeIds={plan.map((p) => p.exerciseId)}
          onClose={() => setPickerOpen(false)}
          onPick={(picked) => {
            setRows((prev) => [
              ...(prev ?? []),
              {
                exerciseId: picked.id,
                name: picked.name,
                type: picked.type,
                muscles: picked.muscles,
                targetSets: picked.sets,
                targetReps: picked.reps,
                selected: true,
                lastLabel: null,
              },
            ]);
            setPickerOpen(false);
            toast.show(`加了「${picked.name}」· 只影响本次会话`);
          }}
        />
      </Sheet>

      {/* 换部位（FR-4）：选了就换这一天的槽位清单；URL 带上 ?part=，刷新 / 返回都还在 */}
      <PartPicker
        open={partOpen}
        mode={mode}
        currentPart={data.part}
        onClose={() => setPartOpen(false)}
        onPick={pickPart}
      />
    </main>
  );
}

/**
 * useSearchParams() 需要 Suspense 边界（Next 静态预渲染的硬要求），
 * 所以页面做成「壳 + 内容」两层。
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="card mt-10 h-40 animate-pulse" />}>
      <SessionPlanPageInner />
    </Suspense>
  );
}
