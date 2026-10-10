"use client";

/**
 * 记录页（FR-13 / 13.4 / FR-26 / FR-27）：统计卡（周/月切换 + 部位占比 + 动作趋势）
 * + 按期倒序列表 + 补记入口。
 *
 * 口径不变：打卡算出勤、不等于有明细；明细留空不算偷懒，不催补录。
 * 占比按 13.15 大部位口径，组数与容量两档（容量 = Σ total_load_kg × reps，13.1）。
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk, type ExerciseLibraryRow, type HistoryRow, type HistoryStats, type TodayPayload } from "@/client/api";
import { ExercisePicker } from "@/components/exercise-picker";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { TrendChart } from "@/components/trend-chart";
import { Card, Empty, Pill, Sheet } from "@/components/ui";
import { dateInTz, dayLabel, monthLabel } from "@/lib/time";
import { volumeToDisplay } from "@/lib/units";
import { compactNumber, sessionRowMeta } from "@/lib/display";
import { weightTrendLines } from "@/lib/chart/series";

const RANGES = [7, 30] as const;

export default function HistoryPage() {
  const toast = useToast();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [shareBy, setShareBy] = useState<"sets" | "volume">("sets");
  const [showBackfill, setShowBackfill] = useState(false);
  const [backfillDate, setBackfillDate] = useState(dateInTz());
  /** 「已打卡 · 无明细」行的就地补明细（FR-13 v1.18）：选一个动作就给那天建一场 */
  const [fillDate, setFillDate] = useState<string | null>(null);
  // FR-27：选中的「动作 × 变体」（null = 还没选，不默认画）
  const [trendPick, setTrendPick] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: qk.history(),
    queryFn: () => api.get<{ rows: HistoryRow[] }>("/api/v1/sessions?limit=60"),
  });
  // 补明细时要知道那天该练什么（部位名 + 槽位 id）—— 打开选择器才取
  const { data: fillDay } = useQuery({
    queryKey: ["today", "backfill-detail", fillDate],
    enabled: fillDate !== null,
    queryFn: () => api.get<TodayPayload>(`/api/v1/today?date=${fillDate}`),
  });
  const { data: fillLib } = useQuery({
    queryKey: qk.exercises(),
    enabled: fillDate !== null,
    queryFn: () =>
      api.get<{ exercises: ExerciseLibraryRow[]; taxonomy: { muscles: string[] } }>("/api/v1/exercises"),
  });
  const { data: stats } = useQuery({
    queryKey: ["stats", range],
    queryFn: () => api.get<HistoryStats>(`/api/v1/stats?days=${range}`),
  });
  const { data: exerciseList } = useQuery({
    queryKey: ["stats", "exercises"],
    queryFn: () =>
      api.get<{
        rows: { exerciseId: number; exerciseName: string; variantId: number | null; variantLabel: string | null; sets: number; lastDate: string }[];
      }>("/api/v1/stats/exercises"),
  });
  const picked = exerciseList?.rows.find((r) => `${r.exerciseId}#${r.variantId ?? "d"}` === trendPick) ?? null;
  const { data: trend } = useQuery({
    queryKey: ["stats", "trend", trendPick],
    enabled: picked !== null,
    queryFn: () =>
      api.get<{ rows: { date: string; maxWeightKg: number | null; sets: number; volumeKg: number }[] }>(
        `/api/v1/stats/exercise-trend?exercise_id=${picked!.exerciseId}&variant_id=${picked!.variantId ?? ""}&days=90`,
      ),
  });

  const rows = data?.rows ?? [];

  /**
   * 「已打卡 · 无明细」行就地补明细（FR-13 v1.18）：选一个动作 → 给那天建一场**已收工**的会话
   * （小结与打卡都补齐）→ 进详情页接着「+ 加一组」。这样不用再走一遍开练计划页。
   */
  const startFill = useMutation({
    mutationFn: (args: { date: string; part: string; templateId: number | null; exercises: { exercise_id: number; target_sets: number; target_reps: number }[] }) =>
      api.post<{ id: number }>("/api/v1/sessions", {
        client_id: `${args.date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: args.date,
        part: args.part,
        mode: "gym",
        status: "done",
        ...(args.templateId ? { template_id: args.templateId } : {}),
        exercises: args.exercises,
      }),
    onSuccess: async (res, args) => {
      await queryClient.invalidateQueries({ queryKey: qk.history() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      setFillDate(null);
      toast.show(`给 ${args.date} 补了一场 · 点「+ 加一组」接着补`);
      router.push(`/history/session/${res.id}`);
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没补上，再试一次"),
  });

  /** 删某天的有氧（FR-51）：有氧是独立记录，删它不影响训练明细 */
  const removeCardio = useMutation({
    mutationFn: (date: string) => api.del(`/api/v1/cardio?date=${date}`),
    onSuccess: async () => {
      toast.show("有氧记录删了");
      await queryClient.invalidateQueries({ queryKey: qk.history() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "删不掉"),
  });

  // 按月分组（「YYYY 年 M 月」分隔行）：倒序列表里月份一变就插一条
  const groups: { month: string | null; items: HistoryRow[] }[] = [];
  let lastMonth: string | null = null;
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    if (month !== lastMonth) {
      groups.push({ month: monthLabel(row.date), items: [row] });
      lastMonth = month;
    } else {
      groups.at(-1)?.items.push(row);
    }
  }

  const parts = stats?.parts ?? [];
  /** 展示单位（§1.1）：容量与单侧重量按它换算展示，库里始终 kg */
  const unit = stats?.unit ?? "kg";
  const shareMax = Math.max(
    1,
    ...parts.map((p) => (shareBy === "sets" ? p.sets : p.volumeKg)),
  );

  return (
    <main>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">记录</h1>
        <button
          type="button"
          // 文字看着只有 19px 高，但点区要够拇指（issue #4 第 4 项）：.tap-ghost 撑命中区、不动布局
          className="tap-ghost text-[12.5px] text-accent underline underline-offset-2"
          onClick={() => setShowBackfill((v) => !v)}
        >
          {showBackfill ? "收起补记" : "+ 补记"}
        </button>
      </div>
      <p className="muted mt-1 text-[12.5px]">训练历史与统计 · 出勤算数；明细留空不算你偷懒</p>

      {/* FR-13 补记：练了没记的那几天，选个日期把整场落回去（开练流程同款，不强制必填） */}
      {showBackfill && (
        <Card className="mt-3">
          <div className="text-[13px] font-semibold">补记哪天？</div>
          <p className="muted mt-1 text-[11.5px]">进开练流程，动作清单按那天的排期给；不强制记满，提前结束也算练完。</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="date"
              className="input h-9 flex-1 py-1 text-[12.5px]"
              value={backfillDate}
              max={dateInTz()}
              onChange={(e) => e.target.value && setBackfillDate(e.target.value)}
            />
            <a
              className="btn btn-primary shrink-0 px-4"
              href={`/session/plan?mode=gym&date=${backfillDate}`}
            >
              去补记
            </a>
          </div>
        </Card>
      )}

      {/* 统计卡：周（7 天）/ 月（30 天）切换（FR-26）+ 各部位占比两档 */}
      {stats && (
        <Card className="mt-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-1 rounded-xl bg-bg p-1">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`tap rounded-lg px-3 text-[12.5px] font-medium ${range === r ? "bg-card shadow-sm" : "text-muted"}`}
                  onClick={() => setRange(r)}
                >
                  近 {r} 天
                </button>
              ))}
            </div>
            <div className="muted text-[11.5px]">
              {stats.from.slice(5).replace("-", "/")} ~ {stats.to.slice(5).replace("-", "/")}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <StatCell value={compactNumber(volumeToDisplay(stats.volumeKg, unit))} unit={unit} label="总容量" />
            <StatCell value={String(stats.totalSets)} unit="组" label="总组数" />
            <StatCell
              value={stats.plannedDays > 0 ? String(Math.min(100, Math.round((stats.attendedDays / stats.plannedDays) * 100))) : "—"}
              unit="%"
              label="出勤率"
            />
          </div>
          <div className="muted mt-2 text-[11.5px] leading-relaxed">
            出勤率 = 有训练或打卡 {stats.attendedDays} 天 / 计划 {stats.plannedDays} 天（已扣除休息日与节假日；打卡算出勤，不等于有明细）
          </div>

          {parts.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between">
                <div className="text-[12.5px] font-semibold">各部位占比</div>
                <div className="flex gap-1 rounded-xl bg-bg p-1">
                  {(
                    [
                      { key: "sets", label: "按组数" },
                      { key: "volume", label: "按容量" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      className={`tap rounded-lg px-3 text-[11.5px] font-medium ${shareBy === opt.key ? "bg-card shadow-sm" : "text-muted"}`}
                      onClick={() => setShareBy(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 space-y-1">
                {parts.map((p) => {
                  const value = shareBy === "sets" ? p.sets : p.volumeKg;
                  return (
                    <div key={p.group} className="flex items-center gap-2 text-[12.5px]">
                      <span className="w-14 shrink-0">{p.group}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(4, (value / shareMax) * 100)}%` }}
                        />
                      </div>
                      <span className="muted w-16 text-right text-[11.5px]">
                        {shareBy === "sets" ? `${p.sets} 组` : `${compactNumber(volumeToDisplay(p.volumeKg, unit))} ${unit}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      )}

      {/* FR-27 动作重量趋势：按「动作 × 变体」各一条线（13.14），可自选 */}
      <Card className="mt-3">
        <div className="text-[13px] font-semibold">动作重量趋势 · 近 90 天</div>
        {(exerciseList?.rows.length ?? 0) === 0 ? (
          <p className="muted mt-2 text-[12px]">还没有动作记录，练一次就有了。</p>
        ) : (
          <>
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
              {exerciseList!.rows.slice(0, 12).map((r) => {
                const key = `${r.exerciseId}#${r.variantId ?? "d"}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`tap shrink-0 rounded-lg border px-2.5 text-[12px] ${
                      trendPick === key ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted"
                    }`}
                    onClick={() => setTrendPick(key)}
                  >
                    {r.exerciseName}
                    {r.variantLabel ? ` · ${r.variantLabel}` : ""}
                  </button>
                );
              })}
            </div>
            {picked === null ? (
              <p className="muted mt-1 text-[11.5px]">选一个动作看它的重量怎么变（每场取当日最大单侧重量）。</p>
            ) : (
              <div className="mt-2">
                <TrendChart today={dateInTz()} days={90} unit={unit} lines={weightTrendLines(trend?.rows ?? [], unit)} />
                <p className="muted mt-1 text-[11.5px]">
                  {picked.exerciseName}
                  {picked.variantLabel ? ` · ${picked.variantLabel}` : ""} · 重量按该动作的读数口径（13.1：杠铃每侧 / 哑铃每只 / 器械读数），容量另按折算总重算
                </p>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="mt-4 space-y-2">
        {isLoading && <div className="card h-24 animate-pulse" />}
        {!isLoading && rows.length === 0 && <Empty>还没有记录。练完在首页点「开练」就能记。</Empty>}
        {groups.map((group) => (
          <div key={group.month ?? "unknown"}>
            {group.month && (
              <div className="mb-2 mt-4 flex items-center gap-2 first:mt-0">
                <span className="text-[12.5px] font-semibold">{group.month}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div className="space-y-2">
              {group.items.map((row) =>
                row.kind === "session" ? (
                  <Link key={`${row.kind}-${row.id}`} href={`/history/session/${row.id}`} className="block">
                    <Card className="transition-colors active:bg-accent-soft">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-1.5 text-[15px] font-semibold">
                            <span>{row.part || "训练"}</span>
                            {/* 加练（13.17）：非训练日真练了的那一场 */}
                            {row.isExtra && <Pill tone="accent">加练</Pill>}
                          </div>
                          <div className="muted text-[12px]">
                            {dayLabel(row.date, dateInTz())}
                            {row.partOfDay ? ` · ${row.partOfDay}` : ""}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[13px] font-semibold">{row.sets} 组</div>
                          <div className="muted text-[11.5px]">
                            {sessionRowMeta({ volumeKg: row.summary?.volumeKg, mode: row.mode }, unit)}
                          </div>
                        </div>
                      </div>
                    </Card>
                  </Link>
                ) : row.kind === "cardio" ? (
                  // 有氧（FR-51 / v1.16）：单独一行，不算出勤、不进容量、不参与 streak
                  <Card key={`cardio-${row.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold">有氧 · 爬坡走</div>
                        <div className="muted text-[12px]">{dayLabel(row.date, dateInTz())}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Pill tone="plain">{row.cardioMinutes ?? 0} 分钟</Pill>
                        <button
                          type="button"
                          aria-label={`删掉 ${row.date} 的有氧记录`}
                          className="tap rounded-lg border border-border px-2 text-[12.5px] text-alert"
                          disabled={removeCardio.isPending}
                          onClick={async () => {
                            if (
                              !(await confirmDialog({
                                title: `删掉 ${row.date} 的有氧记录？`,
                                body: "只是这条有氧记录，训练明细不受影响。",
                                danger: true,
                                confirmLabel: "删掉",
                              }))
                            ) {
                              return;
                            }
                            removeCardio.mutate(row.date);
                          }}
                        >
                          删
                        </button>
                      </div>
                    </div>
                  </Card>
                ) : (
                  <Card key={`${row.kind}-${row.date}`}>
                    {/* 窄屏（390 / 320px）别把左边挤成竖排（issue #12）：`flex-wrap` 让按钮组整体换行，
                        标题加 `whitespace-nowrap` 保持一行 —— 「外层 nowrap + 左侧只 min-w-0 + 右侧 shrink-0」
                        这个组合会把左列压到「一个字宽」，而 CJK 的最小可断位就是单字（踩坑 18）。 */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 whitespace-nowrap">
                        <div className="text-[15px] font-semibold">已打卡 · 无明细</div>
                        <div className="muted text-[12px]">{dayLabel(row.date, dateInTz())}</div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Pill tone="plain">出勤算数</Pill>
                        {/* FR-13 v1.18：就地补明细 —— 选个动作就给那天建一场，直接进详情加组 */}
                        <button
                          type="button"
                          className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
                          disabled={startFill.isPending}
                          onClick={() => setFillDate(row.date)}
                        >
                          + 加动作
                        </button>
                        {/* 想按那天的完整清单挑（还可调目标组数次数）就走开练流程 */}
                        <Link
                          href={`/session/plan?date=${row.date}`}
                          className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
                        >
                          按计划补（可选）
                        </Link>
                      </div>
                    </div>
                  </Card>
                ),
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="muted mt-4 text-center text-[11.5px]">
        容量按总重计（杠铃含杠 20 kg；助力与弹力带不计容量）
      </p>

      {/* 就地补明细（FR-13 v1.18）：挑一个动作 → 给那天建一场已收工的会话 → 进详情加组 */}
      <Sheet
        open={fillDate !== null}
        title={`给 ${fillDate ?? ""} 补明细`}
        onClose={() => setFillDate(null)}
      >
        <p className="muted text-[12px] leading-relaxed">
          挑一个动作就行（那天该练「{fillDay?.part || "看排期"}」）；建好之后在详情页用「+ 加一组」
          把组补上，补录的组不记组间歇。不催、想不起细节就只记做过的那几个动作。
        </p>
        <ExercisePicker
          open={fillDate !== null}
          title=""
          exercises={fillLib?.exercises ?? []}
          muscles={fillLib?.taxonomy.muscles ?? []}
          prefer={fillDay?.exercises.flatMap((e) => e.muscles) ?? []}
          excludeIds={[]}
          onClose={() => setFillDate(null)}
          onPick={(picked) => {
            if (fillDate === null) return;
            startFill.mutate({
              date: fillDate,
              part: fillDay?.part ?? "",
              templateId: fillDay?.scheme.templateId ?? null,
              exercises: [{ exercise_id: picked.id, target_sets: picked.sets, target_reps: picked.reps }],
            });
          }}
        />
      </Sheet>
    </main>
  );
}

function StatCell({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div className="rounded-xl border border-border px-2 py-2">
      <div className="text-lg font-bold">
        {value}
        {/* 数值与单位之间留一格：49.1k 与 kg 贴在一起会读成「49.1kkg」 */}
        <span className="muted ml-1 text-[10.5px] font-normal">{unit}</span>
      </div>
      <div className="muted text-[11px]">{label}</div>
    </div>
  );
}
