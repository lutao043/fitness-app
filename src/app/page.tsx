"use client";

/**
 * 今日（FR-1~FR-5 / 3.3 / 13.8）。
 *
 * 一眼区（今日卡 + 三项数据）→ 加班卡 → 唯一主操作 → 计划 / 恢复 / 打卡分段面板。
 * 提醒文案与判定都来自服务端的同一个纯函数（13.10），页面只负责显示。
 * 「连续记录」旁有定义入口（13.6），「改练其他部位」走 ?part= 的临时覆盖（FR-4）。
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk, type ReanchorProposal, type SchemeAdmin, type TodayPayload } from "@/client/api";
import { useConfirm } from "@/components/confirm";
import { OvertimeEditor, type OvertimeDraft } from "@/components/overtime-editor";
import { PartPicker } from "@/components/part-picker";
import { useToast } from "@/components/toast";
import { Card, Divider, Empty, ExerciseLine, Pill, RecoveryBar, Row, SectionTitle, Sheet, Stepper } from "@/components/ui";
import { OVERTIME_QUICK_TIMES } from "@/lib/overtime";
import { CARDIO_MINUTES, durationMinutesText } from "@/lib/caliber";
import { addDays, dateInTz, daysUntil, monthDay } from "@/lib/time";
import { formatWeight, kgToDisplay } from "@/lib/units";

type Tab = "plan" | "recovery" | "checkin";

export default function TodayPage() {
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("plan");
  /** 有氧录入面板（FR-50）：今天 / 昨天 + 分钟数步进 */
  const [cardioSheet, setCardioSheet] = useState(false);
  const [cardioSheetDate, setCardioSheetDate] = useState(() => dateInTz());
  const [cardioMinutes, setCardioMinutes] = useState(30);
  /** 连续记录的定义说明（13.6：数字旁给入口，别让他猜） */
  const [streakOpen, setStreakOpen] = useState(false);
  /** 改练其他部位（FR-4） */
  const [partOpen, setPartOpen] = useState(false);
  /** 加班面板（FR-22：null = 关闭；新建与改共用，交互设计说明 §12.4） */
  const [overtimeEdit, setOvertimeEdit] = useState<OvertimeDraft | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.today(),
    queryFn: () => api.get<TodayPayload>("/api/v1/today"),
  });

  // 待确认的重锚建议（FR-38：停练 ≥3 个训练日 → 提醒里先问一句，这里落确认）
  const { data: proposalPayload } = useQuery({
    queryKey: qk.proposals(),
    queryFn: () => api.get<{ proposals: ReanchorProposal[] }>("/api/v1/reanchor/proposals"),
  });
  const proposal = proposalPayload?.proposals[0] ?? null;

  const decideProposal = useMutation({
    mutationFn: (args: { id: number; decision: "accept" | "reject" }) =>
      api.post(`/api/v1/reanchor/proposals/${args.id}`, { decision: args.decision }),
    onSuccess: async (_res, args) => {
      toast.show(args.decision === "accept" ? "已重锚：循环从今天重新开始" : "先不重锚 · 这次暂停期不再问");
      await queryClient.invalidateQueries({ queryKey: qk.proposals() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      await queryClient.invalidateQueries({ queryKey: qk.settings() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没处理成"),
  });

  const skipMutation = useMutation({
    mutationFn: (payload: { date: string; reason: string; confirm?: boolean }) =>
      api.post<{ written: boolean; needs_reanchor?: boolean }>("/api/v1/skip", payload),
    onSuccess: (res, variables) => {
      void queryClient.invalidateQueries({ queryKey: qk.today() });
      if (variables.confirm) {
        toast.show("已顺延，明天补上这个部位", {
          label: "撤销",
          onAction: async () => {
            await api.del(`/api/v1/skip/${variables.date}`);
            await queryClient.invalidateQueries({ queryKey: qk.today() });
          },
        });
      }
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "顺延失败"),
  });

  const checkinMutation = useMutation({
    mutationFn: () => api.post("/api/v1/checkin", { kind: "workout" }),
    onSuccess: async () => {
      toast.show("已打卡（出勤算数，明细留空不算偷懒）");
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
  });

  const overtimeMutation = useMutation({
    mutationFn: (body: { date: string; start: string; note?: string }) =>
      api.post("/api/v1/overtime", body),
    onSuccess: async (res: unknown) => {
      const verdict = (res as { verdictText?: string }).verdictText ?? "";
      toast.show(`已录入今晚加班 · ${verdict}`, {
        label: "撤销",
        onAction: async () => {
          const id = (res as { id: number }).id;
          await api.del(`/api/v1/overtime?id=${id}`);
          await queryClient.invalidateQueries({ queryKey: qk.today() });
        },
      });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
  });

  /**
   * 面板的保存（FR-22：新建 / 修改共用，交互设计说明 §12.4）。
   * 与上面「一点即录」分开：面板录的可能是明天或补录历史，toast 不能说「今晚」。
   */
  const saveOvertime = useMutation({
    mutationFn: (draft: OvertimeDraft) =>
      draft.id === null
        ? api.post("/api/v1/overtime", { date: draft.date, start: draft.start, note: draft.note ?? undefined })
        : api.patch("/api/v1/overtime", {
            id: draft.id,
            date: draft.date,
            start: draft.start,
            note: draft.note,
          }),
    onSuccess: async (_res, draft) => {
      setOvertimeEdit(null);
      toast.show(draft.id === null ? "加班记下了 · 判定立刻重算" : "改好了 · 判定立刻重算，不用删了重录");
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没保存上"),
  });

  const supplementCheckin = useMutation({
    mutationFn: (supplementId: number) =>
      api.post("/api/v1/checkin", { kind: "supplement", ref_id: String(supplementId), date: data?.date }),
    onSuccess: async () => {
      toast.show("打卡了 · 这条提醒今天就消失");
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "打卡失败"),
  });

  const cheatMutation = useMutation({
    mutationFn: () => api.post("/api/v1/cheat-meals", { date: data?.date }),
    onSuccess: async () => {
      toast.show("记下了 · 放纵餐锚点挪到今天，下一轮重新算");
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没记上，再试一次"),
  });

  /* ——— 有氧（FR-50 / v1.16）：只记分钟数，一点即记；同日重复保存 = 覆盖 ——— */

  const saveCardio = useMutation({
    mutationFn: (body: { date: string; minutes: number }) => api.post("/api/v1/cardio", body),
    onSuccess: async (_res, body) => {
      toast.show(`有氧记下了 · ${body.minutes} 分钟（${body.date === data?.date ? "今天" : body.date}）`, {
        label: "撤销",
        onAction: async () => {
          await api.del(`/api/v1/cardio?date=${body.date}`);
          await queryClient.invalidateQueries({ queryKey: qk.today() });
        },
      });
      setCardioSheet(false);
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      await queryClient.invalidateQueries({ queryKey: qk.history() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没记上，再试一次"),
  });

  const removeCardio = useMutation({
    mutationFn: (date: string) => api.del(`/api/v1/cardio?date=${date}`),
    onSuccess: async () => {
      toast.show("有氧记录删了");
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      await queryClient.invalidateQueries({ queryKey: qk.history() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "删不掉"),
  });

  if (isLoading) return <TodaySkeleton />;
  if (error || !data) {
    return (
      <Empty>
        读不到今天的数据（{error instanceof Error ? error.message : "未知错误"}）
        <button className="btn btn-secondary mt-3" onClick={() => void refetch()}>
          重试
        </button>
      </Empty>
    );
  }

  const t = data;
  const done = t.session?.status === "done";
  const doing = t.session?.status === "doing";
  const recorded = done || doing || t.checkin.workout;
  // 加班只在**训练日**判定是否耽误训练（13.11 / v1.20）：循环位「休」当天只作记录
  const overtimeJudged = t.isTrainingDay;
  // 跨零点回执（13.3 / FR-45）：会话按 started_at 归属，跨零点那场在次日早晨也要出回执
  const receiptIsToday = t.receipt?.date === t.date;
  // 有回执时顶部大标题不说「今天该练 X」（FR-45 验收原话）；主操作仍按新的一天算（13.3）
  const headline = t.receipt
    ? receiptIsToday
      ? "今天已练完"
      : "昨晚已练完"
    : t.holiday?.type === "holiday"
      ? "假期不练"
      : t.isRestDay
        ? "今天休息"
        : t.part;
  const unit = t.unit;
  const targetWeight = t.body.latestMorning?.weightKg ?? t.body.latestAny?.weightKg ?? null;
  // 目标值统一读 user 表（不再硬编码 65），与身体页同源
  const target = t.target ?? 65;
  const remainRaw = targetWeight !== null ? Math.round((targetWeight - target) * 10) / 10 : null;
  // 展示单位（§1.1）：库里一律 kg，只有"距目标"这一个数字要换算
  const remain = remainRaw === null ? null : kgToDisplay(remainRaw, unit);

  return (
    <main>
      {/* 跨零点回执（13.3 / FR-45）：练完 6 小时内不让首页说"今天该练 X" */}
      {t.receipt && (
        <div className="mb-3 rounded-xl border border-border bg-card px-3 py-2 text-[12.5px] leading-relaxed">
          {receiptIsToday
            ? `${t.receipt.time} 收工 · 今天接着按循环走`
            : `昨晚 ${t.receipt.time} 收工 · 那场按开始那天记在 ${t.receipt.date} · 今天接着按循环走`}
        </div>
      )}

      {/* 假期表覆盖期提示条（13.12：只陈述状态、没有任何按钮） */}
      {t.holidayGap.text && (
        <div className="mb-3 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] leading-relaxed">
          {t.holidayGap.text}
        </div>
      )}

      <Card>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="muted text-[12.5px]">{t.formatted}</div>
            <div className="mt-0.5 text-2xl font-bold">{headline}</div>
          </div>
          <div className="text-right">
            <Pill tone={t.holiday?.type === "holiday" ? "warn" : t.isTrainingDay ? "accent" : "plain"}>
              {t.holiday?.type === "holiday"
                ? t.holiday.name
                : t.isRestDay
                  ? "循环位：休"
                  : `循环 ${t.scheme.slotIndex + 1}/${t.scheme.cycleLen}`}
            </Pill>
            {t.skipped && (
              <div className="mt-1">
                <Pill tone="plain">已顺延</Pill>
              </div>
            )}
            {t.session?.isExtra && (
              <div className="mt-1">
                <Pill tone="accent">加练</Pill>
              </div>
            )}
          </div>
        </div>

        <Divider />

        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat
            label="距目标"
            value={remain === null ? "—" : `${remain > 0 ? remain : Math.abs(remain)}`}
            unit={remain === null ? "" : remain > 0 ? unit : `${unit}（已到）`}
          />
          {/* 13.6：数字旁给定义入口，点一下看怎么算的 */}
          <Stat label="连续记录" value={String(t.streak)} unit="天" onClick={() => setStreakOpen(true)} />
          <Stat
            label="下次放纵餐"
            // 锚点就是今天（刚报过"吃了"）时，下一个建议日仍是 8 天后 —— 照常显示天数
            value={String(daysUntil(t.date, t.cheat.nextDate))}
            unit="天后"
          />
        </div>
      </Card>

      {/* 停练后重锚询问（FR-38：先问再改，禁止自动重锚；拒绝后本次暂停期不再问） */}
      {proposal && (
        <Card className="mt-3">
          <div className="text-[14px] font-semibold">停练有点久了，要不要把循环重锚？</div>
          <p className="muted mt-1 text-[12px] leading-relaxed">
            建议：以今天为第 {proposal.suggested_position + 1} 位重新起锚（欠账清零）。
            不重锚的话排期保持不变，这次暂停期内不再问你。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className="btn btn-primary min-h-[42px] text-[13.5px]"
              disabled={decideProposal.isPending}
              onClick={() => decideProposal.mutate({ id: proposal.id, decision: "accept" })}
            >
              重锚 · 从头开始
            </button>
            <button
              className="btn btn-secondary min-h-[42px] text-[13.5px]"
              disabled={decideProposal.isPending}
              onClick={() => decideProposal.mutate({ id: proposal.id, decision: "reject" })}
            >
              先不重锚
            </button>
          </div>
        </Card>
      )}

      {/* 欠账（13.8）：摊开欠了几个部位（哪天欠的 + 部位），按先欠的先练补 */}
      {t.debt.text && (
        <>
          <SectionTitle>顺延欠账</SectionTitle>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-semibold">{t.debt.text}</div>
                <div className="muted mt-1 text-[12px]">按顺序补：先欠的先练</div>
              </div>
              {t.debt.needsReanchorBeforeSkip && <Pill tone="warn">建议重锚</Pill>}
            </div>
            {t.debt.owed.length > 0 && (
              <>
                <Divider />
                <div className="space-y-1.5">
                  {t.debt.owed.map((o, i) => (
                    <div key={o.date} className="flex items-center justify-between text-[13px]">
                      <span>
                        <span className="mr-2 text-[11.5px] text-muted">第 {i + 1} 个补</span>
                        {o.part}
                      </span>
                      <span className="muted text-[12px]">{o.date} 欠下</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </>
      )}

      {/* 加班卡（3.3 / FR-22）：一晚这条一点即录，不打字；有记录时行内可「改」（§12.4） */}
      {!t.holiday && (
        <>
          <SectionTitle>今晚加班</SectionTitle>
          <Card>
            {t.overtime.length === 0 ? (
              <>
                <div className="text-[13px]">
                  {overtimeJudged
                    ? "今天要加班？点一下就好（判据固定 22:30）："
                    : "今天要加班？点一下就好（今天休息，加班只作记录）："}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {OVERTIME_QUICK_TIMES.map((start) => (
                    <button
                      key={start}
                      type="button"
                      className="btn btn-secondary min-h-[40px] px-3 text-[13px]"
                      onClick={() => overtimeMutation.mutate({ date: t.date, start })}
                    >
                      {start}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn btn-secondary min-h-[40px] px-3 text-[13px]"
                    onClick={() =>
                      setOvertimeEdit({ id: null, date: t.date, start: OVERTIME_QUICK_TIMES[0], note: "" })
                    }
                  >
                    其他时间…
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                {t.overtime.map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-[14px] font-semibold">{o.start}</span>
                      {o.note && <span className="muted ml-2 text-[12px]">{o.note}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {overtimeJudged ? (
                        <Pill tone={o.verdict === "ok" ? "ok" : "warn"}>
                          {o.verdict === "ok" ? "来得及" : "赶不上"}
                        </Pill>
                      ) : (
                        <span className="muted text-[11.5px]">只记录</span>
                      )}
                      <button
                        type="button"
                        className="tap-ghost text-[12.5px] text-accent underline underline-offset-2"
                        onClick={() => setOvertimeEdit({ id: o.id, date: t.date, start: o.start, note: o.note })}
                      >
                        改
                      </button>
                      <button
                        type="button"
                        className="tap-ghost ml-4 text-[12.5px] text-alert underline underline-offset-2"
                        onClick={() => void handleOvertimeDelete({ id: o.id, date: t.date, start: o.start, note: o.note })}
                      >
                        删
                      </button>
                    </div>
                  </div>
                ))}
                <div className="muted text-[11.5px]">
                  {!overtimeJudged
                    ? "今天休息：加班照记，不参与训练判定（13.11）"
                    : t.overtimeEarliest
                      ? `按 ${t.overtimeEarliest.start} 判定（多条时取开始最早的那条，13.11）`
                      : "多条时按开始最早的那条判定（13.11）"}
                </div>
                {t.overtimeEarliest?.verdict === "late" && !recorded && !t.isRestDay && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-block mt-1"
                    onClick={() => void handleSkip()}
                  >
                    顺延今晚 · 明天补「{t.part}」
                  </button>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      <div className="mt-4 space-y-2">
        {!recorded && t.isTrainingDay && (
          <button
            className="btn btn-primary btn-block min-h-[54px] text-[16px]"
            onClick={() => router.push("/session/plan")}
          >
            开练 · {t.part}
          </button>
        )}
        {/* 非训练日（休 / 假期）想练 = 加练（13.17）：先选部位，练完循环按它顺延 */}
        {!recorded && !t.isTrainingDay && (
          <button
            className="btn btn-primary btn-block min-h-[54px] text-[16px]"
            onClick={() => setPartOpen(true)}
          >
            改为加练 · 选部位
          </button>
        )}
        {doing && (
          <button
            className="btn btn-primary btn-block min-h-[54px] text-[16px]"
            onClick={() => router.push(`/session/${t.session?.id}`)}
          >
            继续训练（进行中）
          </button>
        )}
        {done && (
          <div className="card text-center">
            <div className="font-semibold">今天练完了 ✓</div>
            <div className="muted mt-1 text-[12.5px]">
              {/* 与记录页同一口径（issue #45）：组数 · 时长 · 完成度；全场合计容量不再上首页 */}
              {t.session?.summary?.totalSets ?? 0} 组 · {durationMinutesText(t.session?.summary?.durationSec)}
              {t.session?.completion ? ` · 完成度 ${t.session.completion.setsText}` : ""}
            </div>
            <Link href={`/history/session/${t.session?.id}`} className="tap-ghost mt-2 inline-block text-[13px] text-accent underline">
              看这次详情
            </Link>
          </div>
        )}

        {/* 加练（13.17）：把"循环被顺延到哪"说清楚，别让他自己猜排期 */}
        {t.extraShift && (
          <div className="rounded-xl border border-border bg-card px-3 py-2 text-[12px] leading-relaxed">
            加练已计入循环：
            {t.extraShift.restDate ? `${monthDay(t.extraShift.restDate)} 休（今天没休的顺延到那天）` : ""}
            {t.extraShift.restDate && t.extraShift.nextTraining ? " → " : ""}
            {t.extraShift.nextTraining
              ? `${monthDay(t.extraShift.nextTraining.date)} 接着练「${t.extraShift.nextTraining.part}」`
              : ""}
            。
          </div>
        )}

        {/* 次级操作：两列等宽；按钮个数是奇数时最后一个撑满整行（issue #4 第 5 项：右列不留空格） */}
        <div className="flex flex-wrap gap-2">
          {!recorded && t.isTrainingDay && (
            <button className="btn btn-secondary grow basis-[calc(50%-0.25rem)]" onClick={() => void handleSkip()}>
              今天不练
            </button>
          )}
          {!recorded && t.isTrainingDay && (
            <button
              className="btn btn-secondary grow basis-[calc(50%-0.25rem)]"
              onClick={() => checkinMutation.mutate()}
              title="练了但不想记明细时，点这一下就够"
            >
              只打卡（不记明细）
            </button>
          )}
          {/* FR-4：训练日改练别的部位 —— 只影响今天，不重锚循环（非训练日的入口是上面的「加练」） */}
          {!recorded && t.isTrainingDay && (
            <button className="btn btn-secondary grow basis-[calc(50%-0.25rem)]" onClick={() => setPartOpen(true)}>
              改练其他部位
            </button>
          )}
          <button
            className="btn btn-secondary grow basis-[calc(50%-0.25rem)]"
            onClick={() => router.push("/session/plan?mode=home")}
          >
            居家自重
          </button>
          <button
            className="btn btn-secondary grow basis-[calc(50%-0.25rem)]"
            onClick={() => router.push("/body?quick=1")}
          >
            记体重
          </button>
          {recorded && !done && !t.checkin.workout && (
            <button className="btn btn-secondary grow basis-[calc(50%-0.25rem)]" onClick={() => checkinMutation.mutate()}>
              一键打卡
            </button>
          )}
        </div>
      </div>

      <SectionTitle>今天怎么练</SectionTitle>
      <Card>
        <div className="mb-3 flex gap-1 rounded-xl bg-bg p-1">
          {(
            [
              ["plan", "计划"],
              ["recovery", "恢复"],
              ["checkin", "打卡"],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`tap flex-1 rounded-lg text-[13px] font-medium ${
                tab === key ? "bg-card shadow-sm" : "text-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "plan" &&
          (t.holiday?.type === "holiday" || t.isRestDay ? (
            <Empty>{t.holiday?.type === "holiday" ? `${t.holiday.name}，今天不练` : "循环位是「休」，今天不练"}</Empty>
          ) : t.exercises.length === 0 ? (
            <Empty>
              这个槽位还没配动作 ·
              <Link href="/settings/scheme" className="ml-1 text-accent underline underline-offset-2">
                去规则管理里加
              </Link>
            </Empty>
          ) : (
            <div>
              {t.exercises.map((ex) => {
                const last = ex.lastByVariant.default;
                return (
                  <ExerciseLine
                    key={ex.exerciseId}
                    name={ex.name}
                    meta={ex.muscles.join(" + ")}
                    target={`${ex.targetSets} × ${ex.targetReps}${ex.type === "time" ? " 秒" : ""}`}
                    last={
                      last?.weightKg
                        ? `上次 ${formatWeight(last.weightKg, unit)}`
                        : last?.reps
                          ? `上次 ${last.reps} 次`
                          : null
                    }
                  />
                );
              })}
              <div className="muted mt-2 text-[11.5px]">
                目标组数次数可在「开练」后随时改（只影响本次） · 容量按总重计
              </div>
            </div>
          ))}

        {tab === "recovery" &&
          (t.recovery.length === 0 ? (
            <Empty>还没有训练记录，练一次就有恢复度了</Empty>
          ) : (
            <div>
              {t.recovery.map((r) => (
                <RecoveryBar
                  key={r.group}
                  label={r.group}
                  hoursSince={r.hoursSince}
                  nextDays={r.nextDays}
                  pct={r.pct}
                  state={r.key}
                />
              ))}
              <div className="muted mt-2 text-[11.5px]">
                阈值随循环长度走（{t.scheme.cycleLen} 天循环 →{" "}
                {Math.round(0.5 * t.scheme.cycleLen * 24)} / {Math.round(0.75 * t.scheme.cycleLen * 24)} 小时）
              </div>
              {/* FR-20：最近 7 天各部位训练天数（13.15 大部位口径）—— 漏练一眼看出 */}
              {t.partFrequency.length > 0 && (
                <>
                  <Divider />
                  <div className="muted mb-1.5 text-[12px]">最近 7 天各部位练了几天 · 漏练一眼看出</div>
                  <div className="space-y-1">
                    {t.partFrequency.map((p) => (
                      <div key={p.group} className="flex items-center gap-2 text-[12.5px]">
                        <span className="w-14 shrink-0">{p.group}</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(p.days > 0 ? 6 : 0, (p.days / 7) * 100)}%` }}
                          />
                        </div>
                        <span className="muted w-9 text-right text-[11.5px]">{p.days} 天</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}

        {tab === "checkin" && (
          <div className="space-y-2">
            <Row
              label="训练打卡"
              value={
                t.checkin.workout ? (
                  <Pill tone="ok">已打卡</Pill>
                ) : (
                  <Pill tone="plain">未打卡</Pill>
                )
              }
            />
            {t.checkin.workout && !t.session && (
              <div className="muted text-[12px]">已打卡 · 无明细（出勤算数，明细留空不算偷懒）</div>
            )}
            <Divider />
            {/* 补剂打卡（13.10 第 2 条）：打卡后这条提醒今天就消失；没打卡才提 */}
            {t.supplements.length > 0 ? (
              <div>
                <div className="muted mb-1 text-[12px]">补剂 · 没打卡才提</div>
                <div className="space-y-1.5">
                  {t.supplements.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px]">{s.name}</div>
                        <div className="muted truncate text-[11.5px]">
                          {s.doseText}
                          {s.times.length > 0 ? ` · ${s.times.join(" / ")}` : ""}
                        </div>
                      </div>
                      {s.takenToday ? (
                        <Pill tone="ok">已打卡 ✓</Pill>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary min-h-[36px] shrink-0 px-3 text-[12.5px]"
                          disabled={supplementCheckin.isPending}
                          onClick={() => supplementCheckin.mutate(s.id)}
                        >
                          打卡
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Row label="补剂" value={<span className="muted text-[12.5px]">还没配补剂</span>} />
            )}
            <Divider />
            <Row label="今天该练" value={t.isRestDay ? "休" : t.part} />
            <Row label="今天不练" value={t.skipped ? "已顺延" : "未顺延"} />
          </div>
        )}
      </Card>

      {/* 放纵餐（3.4 / FR-25）：只提醒不强制，「今天真吃了」把锚点挪到今天 */}
      <SectionTitle>放纵餐 · 只提醒不强制</SectionTitle>
      <Card>
        <div className="text-[13.5px]">
          {t.cheat.daysSince === null ? (
            <>还没有记录，下次建议 <span className="font-semibold">{t.cheat.nextDate}</span> {t.cheat.when}</>
          ) : (
            <>
              距上次 <span className="font-semibold">{t.cheat.daysSince}</span> 天，下次建议{" "}
              <span className="font-semibold">{t.cheat.nextDate}</span> {t.cheat.when}
            </>
          )}
        </div>
        <div className="muted mt-1 text-[11.5px] leading-relaxed">
          想吃就吃，你定。间隔 {t.cheat.intervalDays} 天一轮，撞上工作日会顺延到最近的周末。
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-block mt-3"
          disabled={cheatMutation.isPending}
          onClick={() => cheatMutation.mutate()}
        >
          今天真吃了（锚点挪到今天）
        </button>
      </Card>

      {/* 有氧（FR-50 / 3.6）：只记分钟数、形式固定「爬坡走」，坡度速度不记（不做精算） */}
      <SectionTitle>有氧 · 爬坡走（可选，不催）</SectionTitle>
      <Card>
        {t.cardio.today ? (
          <>
            <div className="text-[13.5px]">
              今天已记 <span className="font-semibold">{t.cardio.today.minutes}</span> 分钟
              <span className="muted ml-2 text-[12px]">
                近 7 天 {t.cardio.weekDays} 天 · 合计 {t.cardio.weekMinutes} 分钟
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px]"
                onClick={() => {
                  setCardioSheetDate(t.date);
                  setCardioSheet(true);
                }}
              >
                改分钟数
              </button>
              <button
                className="btn btn-secondary min-h-[42px] text-[13.5px] text-alert"
                disabled={removeCardio.isPending}
                onClick={() => removeCardio.mutate(t.date)}
              >
                删掉
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[13px]">今天走了爬坡？点一下分钟数就记完（不想记就不记）：</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {[20, 30, 40].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className="btn btn-secondary min-h-[40px] px-3 text-[13px]"
                  disabled={saveCardio.isPending}
                  onClick={() => saveCardio.mutate({ date: t.date, minutes })}
                >
                  {minutes} 分钟
                </button>
              ))}
              <button
                type="button"
                className="btn btn-secondary min-h-[40px] px-3 text-[13px]"
                onClick={() => {
                  setCardioSheetDate(t.date);
                  setCardioSheet(true);
                }}
              >
                其他分钟数…
              </button>
            </div>
            <div className="muted mt-2 text-[11.5px]">
              近 7 天 {t.cardio.weekDays} 天 · 合计 {t.cardio.weekMinutes} 分钟 · 只做记录，不算出勤也不进容量
            </div>
          </>
        )}
      </Card>

      <SectionTitle>提醒预告 · 判定链唯一来源</SectionTitle>
      <Card>
        <div className="text-[13px] leading-relaxed">{t.reminders.statusText}</div>
        <div className="muted mt-1 text-[11.5px]">
          提醒时间 {t.reminders.time}
          {t.reminders.enabled ? "" : "（已关闭）"} · 加班判据固定 22:30，不跟着它拨
        </div>
      </Card>

      {/* 改练其他部位（FR-4）：选一个槽位 → 开练流程带上 ?part=，只影响今天 */}
      <PartPicker
        open={partOpen}
        mode="gym"
        currentPart={t.part}
        onClose={() => setPartOpen(false)}
        onPick={(slot: SchemeAdmin["slots"][number]) => {
          setPartOpen(false);
          router.push(`/session/plan?part=${slot.templateId}&mode=gym`);
        }}
      />

      {/* 加班面板（FR-22 / §12.4）：新建（「其他时间…」）与「改」共用，删也走同一个撤销逻辑 */}
      <OvertimeEditor
        draft={overtimeEdit}
        onClose={() => setOvertimeEdit(null)}
        onSubmit={(draft) => saveOvertime.mutate(draft)}
        // 13.11 / v1.20：休息日的加班只作记录，判定预告不拿"耽误训练"说事
        dayTypeOf={(date) => t.dayTypes?.[date] ?? null}
        onDelete={(draft) => {
          if (draft.id === null) return;
          setOvertimeEdit(null);
          void handleOvertimeDelete({ id: draft.id, date: draft.date, start: draft.start, note: draft.note });
        }}
      />

      {/* 连续记录的定义（13.6）：数字旁点一下就看得懂，别让他猜为什么昨天没记也没断 */}
      <Sheet open={streakOpen} title="连续记录" onClose={() => setStreakOpen(false)}>
        <p className="muted text-[12px]">这个数字是怎么算的</p>
        <div className="mt-3 space-y-1.5 text-[13px] leading-relaxed">
          <div>
            有记录 = 当天有<b>体重</b>、<b>训练</b>或<b>打卡</b>，任一条就算（补剂打卡不算）。
          </div>
          <div>
            断签只在<b>训练日</b>判定：那天该练、完全没记录、又没顺延 → 断。
          </div>
          <div>
            「休」日与法定节假日<b>不参与判定</b>：既不要求你记，也不会因此断。
          </div>
          <div>点过「今天不练（顺延）」的日子不算断。</div>
          <div>今天还没记也不算断 —— 早上打开不会看到它清零。</div>
          <div>
            当前位置：<b>{t.streak} 天</b>。
          </div>
        </div>
        <button className="btn btn-secondary btn-block mt-4" onClick={() => setStreakOpen(false)}>
          知道了
        </button>
      </Sheet>

      {/* 有氧录入面板（FR-50）：今天 / 昨天 + 分钟数；只记分钟数，坡度速度不记 */}
      <Sheet open={cardioSheet} title="记有氧（爬坡走）" onClose={() => setCardioSheet(false)}>
        <p className="muted text-[12px] leading-relaxed">
          只记分钟数（坡度与速度不记，不做精算）。同一天重复保存会覆盖，不会记出两条。
        </p>
        <div className="mt-3 flex gap-1.5">
          {(
            [
              ["今天", t.date],
              ["昨天", addDays(t.date, -1)],
            ] as [string, string][]
          ).map(([label, value]) => (
            <button
              key={label}
              type="button"
              className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                cardioSheetDate === value ? "border-accent bg-accent-soft font-semibold" : "border-border"
              }`}
              onClick={() => setCardioSheetDate(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[13.5px]">分钟数</span>
          <Stepper label="分钟" value={cardioMinutes} max={CARDIO_MINUTES.max} onChange={setCardioMinutes} />
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {[20, 30, 40, 50].map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`rounded-lg border px-2.5 py-1 text-[12.5px] ${
                cardioMinutes === minutes ? "border-accent bg-accent-soft font-semibold" : "border-border"
              }`}
              onClick={() => setCardioMinutes(minutes)}
            >
              {minutes}
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary btn-block mt-4 min-h-[46px]"
          disabled={saveCardio.isPending}
          onClick={() => saveCardio.mutate({ date: cardioSheetDate, minutes: cardioMinutes })}
        >
          记下 {cardioSheetDate === t.date ? "今天" : "昨天"}的 {cardioMinutes} 分钟
        </button>
      </Sheet>
    </main>
  );

  /**
   * 删一条加班记录（FR-22 / §12.5）：列表行与面板「删除」共用，
   * 5 秒内可在 toast 里撤销（误删会让当晚判定与催练都失准，代价比多留一个按钮大）。
   */
  async function handleOvertimeDelete(row: { id: number; date: string; start: string; note: string | null }) {
    await api.del(`/api/v1/overtime?id=${row.id}`);
    toast.show("已删除加班记录", {
      label: "撤销",
      onAction: async () => {
        await api.post("/api/v1/overtime", {
          date: row.date,
          start: row.start,
          note: row.note ?? undefined,
        });
        await queryClient.invalidateQueries({ queryKey: qk.today() });
      },
    });
    await queryClient.invalidateQueries({ queryKey: qk.today() });
  }

  async function handleSkip() {
    const res = await api
      .post<{ written: boolean }>("/api/v1/skip", { date: t.date, reason: "missed" })
      .catch((err: unknown) => err as Error & { status?: number });
    if (res instanceof Error) {
      // 409 = 欠账到上限，先问重锚（13.8：第 3 次顺延先弹询问）
      if ((res as { status?: number }).status === 409) {
        const accept = await confirmDialog({
          title: "已经欠 2 个部位了。要以今天重锚、把欠账清零吗？",
          body: "点「取消」= 照写顺延，欠账继续累",
          confirmLabel: "以今天重锚",
        });
        if (accept) {
          await api.post("/api/v1/reanchor", { date: t.date, cycle_position: 0, reason: "pause_resume" });
          toast.show("已以今天重锚，循环从头开始");
        } else {
          skipMutation.mutate({ date: t.date, reason: "missed", confirm: true });
        }
        await queryClient.invalidateQueries({ queryKey: qk.today() });
        return;
      }
      toast.show(res.message);
      return;
    }
    skipMutation.mutate({ date: t.date, reason: "missed", confirm: true });
  }
}

function Stat({
  label,
  value,
  unit,
  onClick,
}: {
  label: string;
  value: string;
  unit: string;
  /** 给了就是可点入口（13.6：连续记录点一下看怎么算的） */
  onClick?: () => void;
}) {
  const body = (
    <div>
      <div className="text-xl font-bold">
        {value}
        <span className="muted ml-0.5 text-[11.5px] font-normal">{unit}</span>
      </div>
      <div className="muted text-[11.5px]">
        {label}
        {onClick && <span className="ml-0.5 text-accent">ⓘ</span>}
      </div>
    </div>
  );
  if (!onClick) return body;
  return (
    <button type="button" className="w-full" onClick={onClick} aria-label={`${label}：点一下看怎么算的`}>
      {body}
    </button>
  );
}

function TodaySkeleton() {
  return (
    <main className="space-y-3">
      <div className="card h-28 animate-pulse" />
      <div className="card h-20 animate-pulse" />
      <div className="card h-40 animate-pulse" />
    </main>
  );
}
