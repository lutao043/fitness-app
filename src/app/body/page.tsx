"use client";

import { Suspense } from "react";

/**
 * 身体页（FR-14 / 13.2 / FR-15~17）：体重 + 围度 + 曲线 + 目标预估。
 *
 * 口径（13.2）：同一时点一天一条，重复保存 = 覆盖；大数字优先显示晨起，没有才退睡前；
 * **曲线与预估一律基于晨起序列**，睡前作浅色参考线、两条不混线；序列比较显式按日期（别用数组下标）。
 * 围度（FR-15）：不强制天天记，每周一次足够；同日一条，重复保存 = 覆盖。
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk, type BodyAnalysisRow, type BodySeries, type MeasurementRow } from "@/client/api";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { TrendChart, type ChartLine } from "@/components/trend-chart";
import { Card, Divider, Empty, Pill, Row, SectionTitle } from "@/components/ui";
import { MEASUREMENT_METRICS, measurementLines } from "@/lib/chart/series";
import { addDays, dateInTz } from "@/lib/time";
import { BODY_FAT_PCT, estimateGoalEta, goalEtaText } from "@/lib/caliber";
import { displayToKg, formatWeight, kgToDisplay } from "@/lib/units";

const SLOTS = [
  { key: "morning", label: "晨起空腹" },
  { key: "bedtime", label: "睡前" },
  { key: "other", label: "其他" },
] as const;

/** 趋势解读（FR-57）：level → 中文徽标 + 三色（正常波动 / 值得留意 / 数据可疑） */
const ANALYSIS_LABELS: Record<BodyAnalysisRow["level"], string> = {
  normal: "正常波动",
  watch: "值得留意",
  suspect: "数据可疑",
};
const ANALYSIS_TONES: Record<BodyAnalysisRow["level"], "ok" | "warn" | "alert"> = {
  normal: "ok",
  watch: "warn",
  suspect: "alert",
};

const RANGES = [7, 30, 90] as const;

type MetricKey = (typeof MEASUREMENT_METRICS)[number]["key"];

const METRICS = MEASUREMENT_METRICS;

function BodyPageInner() {
  const params = useSearchParams();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(dateInTz());
  const [slot, setSlot] = useState<"morning" | "bedtime" | "other">("morning");
  const [weight, setWeight] = useState("");
  const [bodyFat, setBodyFat] = useState("");
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  /** FR-17：围度可**多选叠加对比** —— 至少留一个，点已选中的那个就是取消 */
  const [metrics, setMetrics] = useState<MetricKey[]>(["waistCm"]);
  const [showMeasureForm, setShowMeasureForm] = useState(false);
  /** 趋势解读（FR-57）：默认只显示最新一条，点开看更早的 */
  const [showAnalysisAll, setShowAnalysisAll] = useState(false);
  const [measure, setMeasure] = useState<Record<string, string>>({ waistCm: "", chestCm: "", armCm: "", thighCm: "" });

  // 体脂率范围（13.2，issue #10 R1）：范围常量与提示文案都从**同一份**来（issue #28）——
  // 改上限时页面提示与服务端 400 同时跟着变，不会各说各话
  const fatText = bodyFat.trim();
  const fatValue = fatText === "" ? null : Number(fatText);
  const fatIssue =
    fatValue !== null &&
    (!Number.isFinite(fatValue) || fatValue < BODY_FAT_PCT.min || fatValue > BODY_FAT_PCT.max)
      ? `体脂 % 请填 ${BODY_FAT_PCT.min}~${BODY_FAT_PCT.max} 之间的数字`
      : null;

  const { data, isLoading } = useQuery({
    queryKey: qk.body(),
    queryFn: () => api.get<BodySeries>("/api/v1/body-metrics?limit=365"),
  });
  const { data: measureData } = useQuery({
    queryKey: qk.measurements(),
    queryFn: () => api.get<{ rows: MeasurementRow[] }>("/api/v1/measurements?limit=365"),
  });
  // 趋势解读（FR-57 / v1.29）：助手写入、网页只读 —— 独立 query，接口失败时整块不渲染、其余区块照常
  const { data: analysisData } = useQuery({
    queryKey: qk.bodyAnalysis(),
    queryFn: () => api.get<{ items: BodyAnalysisRow[] }>("/api/v1/body-analysis?limit=30"),
  });

  // 从首页「记体重」过来时把时点按"最近 7 天用得多的那个"预选（13.2：少一步选择，但如实存 slot）
  useEffect(() => {
    if (params.get("quick") !== "1" || !data) return;
    const recent = data.series.slice(-7);
    const bedtime = recent.filter((s) => s.slot === "bedtime").length;
    const morning = recent.filter((s) => s.slot === "morning").length;
    setSlot(bedtime > morning ? "bedtime" : "morning");
  }, [params, data]);

  const save = useMutation({
    mutationFn: () =>
      api.post<{ created: boolean; date: string; slot: string }>("/api/v1/body-metrics", {
        date,
        slot,
        // 界面按展示单位输入，入库一律 kg（§1.1）
        weight_kg: displayToKg(Number(weight), unit) ?? 0,
        body_fat_pct: fatValue === null ? undefined : fatValue,
      }),
    onSuccess: async (res) => {
      toast.show(res.created ? "记下了" : "同一天同一时点已更新（覆盖）");
      setWeight("");
      setBodyFat("");
      await queryClient.invalidateQueries({ queryKey: qk.body() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "保存失败"),
  });

  // 删掉某天某时点这一条（记错日期 / 称重失败时用；覆盖修不了这两类，issue #10 附带一问）
  const remove = useMutation({
    mutationFn: (target: { date: string; slot: string }) =>
      api.del<{ removed: boolean }>(`/api/v1/body-metrics?date=${target.date}&slot=${target.slot}`),
    onSuccess: async (res) => {
      toast.show(res.removed ? "删掉了这一条" : "这条已经不在了");
      await queryClient.invalidateQueries({ queryKey: qk.body() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "删除失败"),
  });

  const saveMeasure = useMutation({
    mutationFn: () =>
      api.post<{ created: boolean }>("/api/v1/measurements", {
        date: dateInTz(),
        waist_cm: measure.waistCm === "" ? undefined : Number(measure.waistCm),
        chest_cm: measure.chestCm === "" ? undefined : Number(measure.chestCm),
        arm_cm: measure.armCm === "" ? undefined : Number(measure.armCm),
        thigh_cm: measure.thighCm === "" ? undefined : Number(measure.thighCm),
      }),
    onSuccess: async (res) => {
      toast.show(res.created ? "围度记下了" : "今天的围度已更新（覆盖）");
      setMeasure({ waistCm: "", chestCm: "", armCm: "", thighCm: "" });
      setShowMeasureForm(false);
      await queryClient.invalidateQueries({ queryKey: qk.measurements() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "保存失败"),
  });

  const series = data?.series ?? [];
  /** 趋势解读（FR-57）：倒序（最新在前），没有记录时整块不渲染 */
  const analysis = analysisData?.items ?? [];
  /** 展示单位（§1.1）：库里一律 kg，展示与录入都按它换算 */
  const unit = data?.unit ?? "kg";
  const morningAll = series.filter((s) => s.slot === "morning");
  const latestMorning = morningAll.at(-1) ?? null;
  const startMorning = morningAll[0] ?? null;
  const target = data?.target ?? 65;
  const remain =
    latestMorning !== null ? Math.round((latestMorning.weightKg - target) * 10) / 10 : null;
  const remainDisplay = remain === null ? null : kgToDisplay(remain, unit);
  const targetDisplay = kgToDisplay(target, unit) ?? target;
  // 进度条量程 = 起点（最早一次晨起）→ 目标，不再假设固定 7 kg 量程
  const goalPct = (() => {
    if (!startMorning || !latestMorning) return 0;
    const span = startMorning.weightKg - target;
    if (span === 0) return latestMorning.weightKg <= target ? 100 : 0;
    return Math.round(((startMorning.weightKg - latestMorning.weightKg) / span) * 100);
  })();

  // FR-16：近 14 天晨起趋势 → 预估达成日（窗口独立于曲线档位，口径固定）
  const eta = estimateGoalEta({ today: dateInTz(), targetKg: target, morning: morningAll });

  const measurements = measureData?.rows ?? [];
  const latestMeasure = measurements.at(-1) ?? null;
  const measureFilled = METRICS.some((m) => measure[m.key] !== "");

  return (
    <main>
      <h1 className="text-xl font-bold">身体</h1>

      <SectionTitle>记体重</SectionTitle>
      <Card>
        <div className="flex gap-1 rounded-xl bg-bg p-1">
          {SLOTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`tap flex-1 rounded-lg text-[12.5px] font-medium ${slot === s.key ? "bg-card shadow-sm" : "text-muted"}`}
              onClick={() => setSlot(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="muted text-[12px]" htmlFor="weight">
              体重（{unit}）
            </label>
            <input
              id="weight"
              className="input mt-1 text-xl font-bold"
              inputMode="decimal"
              placeholder={latestMorning ? String(kgToDisplay(latestMorning.weightKg, unit)) : unit === "lb" ? "154.0" : "70.0"}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div className="w-24">
            <label className="muted text-[12px]" htmlFor="fat">
              体脂 %
            </label>
            <input
              id="fat"
              className="input mt-1"
              inputMode="decimal"
              placeholder="选填"
              value={bodyFat}
              onChange={(e) => setBodyFat(e.target.value)}
            />
          </div>
        </div>
        {fatIssue && <p className="text-warn mt-2 text-[11.5px]">{fatIssue}</p>}

        {/* 窄屏（320px）别把「记到哪天」挤成竖排（issue #12 的同类炸点）：允许换行 + 标签不拆字 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="muted whitespace-nowrap text-[12.5px]">记到哪天</span>
          <button
            type="button"
            className={`tap rounded-lg px-2.5 text-[12.5px] ${date === dateInTz() ? "bg-accent text-accent-fg" : "border border-border"}`}
            onClick={() => setDate(dateInTz())}
          >
            今天
          </button>
          <button
            type="button"
            className={`tap rounded-lg px-2.5 text-[12.5px] ${date !== dateInTz() ? "bg-accent text-accent-fg" : "border border-border"}`}
            onClick={() => setDate(shiftDate(dateInTz(), -1))}
          >
            昨天
          </button>
          <input
            className="input h-9 w-36 py-1 text-[12.5px]"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || dateInTz())}
          />
        </div>

        <button
          className="btn btn-primary btn-block mt-4"
          disabled={!weight || fatIssue !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
        <p className="muted mt-2 text-[11.5px]">同一时点一天一条，再存就是覆盖；晨起与睡前各存一条，不混线</p>
      </Card>

      <SectionTitle>目标进度</SectionTitle>
      <Card>
        <Row
          label="最新晨起体重"
          value={latestMorning ? formatWeight(latestMorning.weightKg, unit) : "还没有记录"}
          hint={latestMorning ? latestMorning.date : undefined}
        />
        <Row
          label={`距目标 ${targetDisplay} ${unit}`}
          value={
            remainDisplay === null
              ? "—"
              : remainDisplay > 0
                ? `还差 ${remainDisplay} ${unit}`
                : `已达标（${Math.abs(remainDisplay)} ${unit}）`
          }
        />
        <Divider />
        <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.max(2, Math.min(100, goalPct))}%` }}
          />
        </div>
        <div className="muted mt-2 flex justify-between text-[11px]">
          <span>起点 {startMorning ? formatWeight(startMorning.weightKg, unit) : "—"}</span>
          <span>
            目标 {targetDisplay} {unit}
          </span>
        </div>
        {/* FR-16：按近 14 天晨起趋势外推；数字会因放纵餐/水分跳变，免责固定在旁（设计说明 §7） */}
        <Divider />
        <Row label="预估达成" value={goalEtaText(eta, target, unit)} />
        <p className="muted mt-1 text-[11.5px]">按当前速率估算，仅供参考；只按晨起序列算（13.2）</p>
      </Card>

      {/* 趋势解读（FR-57 / v1.29）：助手写入、网页只读 —— 页面上不提供生成 / 编辑入口；
          没有解读时整块不渲染（不留空白卡片），接口失败也只是这块不出现 */}
      {analysis.length > 0 && (
        <>
          <SectionTitle>趋势解读</SectionTitle>
          <Card>
            {(() => {
              const [latest, ...older] = analysis;
              return (
                <>
                  <div className="flex items-center gap-2">
                    <Pill tone={ANALYSIS_TONES[latest.level]}>{ANALYSIS_LABELS[latest.level]}</Pill>
                    <span className="muted text-[12px]">{latest.date}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed">{latest.text}</p>
                  {older.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="tap-ghost mt-3 text-[12.5px] text-accent underline underline-offset-2"
                        onClick={() => setShowAnalysisAll((v) => !v)}
                      >
                        {showAnalysisAll ? "收起更早的解读" : `看更早的 ${older.length} 条`}
                      </button>
                      {showAnalysisAll && (
                        <div className="mt-2 space-y-3">
                          {older.map((row) => (
                            <div key={row.date} className="border-t border-border pt-3">
                              <div className="flex items-center gap-2">
                                <Pill tone={ANALYSIS_TONES[row.level]}>{ANALYSIS_LABELS[row.level]}</Pill>
                                <span className="muted text-[12px]">{row.date}</span>
                              </div>
                              <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed">{row.text}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </Card>
        </>
      )}

      <SectionTitle>趋势</SectionTitle>
      <div className="mb-2 flex gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={`tap flex-1 rounded-lg border px-2 text-[12.5px] ${
              range === r ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted"
            }`}
            onClick={() => setRange(r)}
          >
            近 {r} 天
          </button>
        ))}
      </div>

      <Card className="mb-3">
        <div className="mb-2 text-[13px] font-semibold">体重 · 只连晨起（13.2）</div>
        <TrendChart today={dateInTz()} days={range} unit={unit} lines={weightLines(series, range, unit)} />
        <p className="muted mt-2 text-[11.5px]">
          晨起为实线；{range >= 30 ? "睡前/其他作浅色参考线，不与晨起连线。" : "窗口内没有睡前记录。"}
        </p>
      </Card>

      <Card className="mb-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[13px] font-semibold">围度 · 每周记一次就够（FR-15）</div>
          <button
            type="button"
            className="tap-ghost text-[12.5px] text-accent underline underline-offset-2"
            onClick={() => setShowMeasureForm((v) => !v)}
          >
            {showMeasureForm ? "收起" : "记围度"}
          </button>
        </div>

        {showMeasureForm && (
          <div className="mb-3 rounded-xl border border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              {METRICS.map((m) => (
                <div key={m.key}>
                  <label className="muted text-[12px]" htmlFor={`m-${m.key}`}>
                    {m.label}（cm）
                  </label>
                  <input
                    id={`m-${m.key}`}
                    className="input mt-1"
                    inputMode="decimal"
                    placeholder={latestMeasure?.[m.key] != null ? String(latestMeasure[m.key]) : "选填"}
                    value={measure[m.key]}
                    onChange={(e) => setMeasure((prev) => ({ ...prev, [m.key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <button
              className="btn btn-primary btn-block mt-3"
              disabled={!measureFilled || saveMeasure.isPending}
              onClick={() => saveMeasure.mutate()}
            >
              保存（记到今天 · 同日覆盖）
            </button>
          </div>
        )}

        {measurements.length === 0 ? (
          <Empty>还没有围度记录 · 腰围变化最能说明减脂有没有生效</Empty>
        ) : (
          <>
            <div className="muted mb-1.5 text-[11.5px]">点指标可多选，几条曲线叠在一张图里对比</div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {METRICS.map((m) => {
                const active = metrics.includes(m.key);
                return (
                  <button
                    key={m.key}
                    type="button"
                    aria-pressed={active}
                    className={`tap gap-1.5 rounded-lg border px-2 text-[12px] ${
                      active ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted"
                    }`}
                    onClick={() =>
                      setMetrics((prev) =>
                        prev.includes(m.key)
                          ? prev.length > 1
                            ? prev.filter((k) => k !== m.key)
                            : prev // 至少留一个，全不选等于图空白
                          : [...prev, m.key],
                      )
                    }
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: m.color }} aria-hidden />
                    {m.label}
                  </button>
                );
              })}
            </div>
            <TrendChart
              today={dateInTz()}
              days={range}
              unit="cm"
              lines={measurementLines(
                measurements,
                METRICS.filter((m) => metrics.includes(m.key)),
                range,
                dateInTz(),
              )}
            />
            <div className="muted mt-2 text-[11.5px]">
              最新：{METRICS.map((m) => (latestMeasure?.[m.key] != null ? `${m.label} ${latestMeasure[m.key]}` : null))
                .filter(Boolean)
                .join(" · ")}
              {latestMeasure ? `（${latestMeasure.date}）` : ""}
            </div>
          </>
        )}
      </Card>

      <SectionTitle>最近记录</SectionTitle>
      <Card>
        {isLoading && <div className="h-20 animate-pulse" />}
        {!isLoading && series.length === 0 && <Empty>还没有体重记录</Empty>}
        <div className="space-y-1.5">
          {series
            .slice()
            .reverse()
            .slice(0, 14)
            .map((s) => {
              // 与上一条**同时点**记录的差值（13.2：晨起与睡前不混线）
              const idx = series.findIndex((x) => x.id === s.id);
              const prevSameSlot = series
                .slice(0, idx)
                .filter((x) => x.slot === s.slot)
                .at(-1);
              const diff = prevSameSlot
                ? Math.round((s.weightKg - prevSameSlot.weightKg) * 10) / 10
                : null;
              return (
                <div key={s.id} className="flex items-center justify-between text-[13px]">
                  <span className="muted">{s.date}</span>
                  <span className="flex items-center gap-2">
                    <Pill tone={s.slot === "morning" ? "accent" : "plain"}>
                      {s.slot === "morning" ? "晨起" : s.slot === "bedtime" ? "睡前" : "其他"}
                    </Pill>
                    <span className="font-semibold">{formatWeight(s.weightKg, unit)}</span>
                    {diff !== null && diff !== 0 && (
                      <span className={`text-[11.5px] ${diff < 0 ? "text-ok" : "muted"}`}>
                        {diff > 0 ? "+" : ""}
                        {kgToDisplay(diff, unit)}
                      </span>
                    )}
                    {s.bodyFatPct ? <span className="muted text-[11.5px]">{s.bodyFatPct}%</span> : null}
                    <button
                      className="tap-ghost text-[11.5px] leading-5 text-alert underline underline-offset-2"
                      onClick={() => {
                        void confirmDialog({
                          title: "删掉这条体重？",
                          body: `${s.date} · ${s.slot === "morning" ? "晨起" : s.slot === "bedtime" ? "睡前" : "其他"} · ${formatWeight(s.weightKg, unit)}`,
                          danger: true,
                        }).then((ok) => {
                          if (ok) remove.mutate({ date: s.date, slot: s.slot });
                        });
                      }}
                    >
                      删
                    </button>
                  </span>
                </div>
              );
            })}
        </div>
      </Card>
    </main>
  );
}

/* ———————————————— 曲线数据组装（FR-17）：画图组件在 components/trend-chart.tsx ———————————————— */

function weightLines(series: BodySeries["series"], days: number, unit: "kg" | "lb"): ChartLine[] {
  const today = dateInTz();
  const from = addDays(today, -(days - 1));
  const inWindow = series.filter((s) => s.date >= from && s.date <= today);
  const bySlot = (slots: string[]) => inWindow.filter((s) => slots.includes(s.slot));
  // 曲线按展示单位画（§1.1）：库里是 kg，纵轴标签跟着设置走
  const toPoints = (rows: BodySeries["series"]) =>
    rows.map((s) => ({ date: s.date, value: kgToDisplay(s.weightKg, unit) ?? s.weightKg }));
  return [
    { color: "var(--accent)", points: toPoints(bySlot(["morning"])) },
    // 睡前/其他 = 浅色参考线；两条不混线（13.2）
    { color: "var(--muted)", dashed: true, points: toPoints(bySlot(["bedtime", "other"])) },
  ].filter((l) => l.points.length > 0);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * useSearchParams() 需要 Suspense 边界（Next 静态预渲染的硬要求），
 * 所以页面做成「壳 + 内容」两层。
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="card mt-10 h-40 animate-pulse" />}>
      <BodyPageInner />
    </Suspense>
  );
}
