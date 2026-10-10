"use client";

/**
 * 提醒判定演练（FR-55 / 13.10）——「我的 → 提醒」里的只读工具页。
 *
 * 把判定时刻拨到任意 HH:mm，直接看那条判定链每一条的命中情况、会发什么（标题 / 正文 / 一键动作），
 * 以及每种补剂到点该不该提。用来跟设备实际行为对拍（10.1 并行期）。
 *
 * **只读**：不生成事件、不写去重与投递记录 —— 演练把当天的真投递顶掉就没法验证了。
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/client/api";
import { Card, Divider, Empty, Pill } from "@/components/ui";

interface Step {
  no: number;
  name: string;
  hit: boolean;
  detail: string;
}

interface PreviewPayload {
  date: string;
  at: string;
  checkTime: string;
  decision: {
    verdict: "silent" | "send";
    reason: string;
    hitNo: number;
    title: string | null;
    body: string | null;
    action: "checkin" | "skip" | "ack" | null;
    beforeCheckTime: boolean;
    steps: Step[];
  };
  input: {
    partLabel: string;
    nextPartLabel: string;
    holidayName: string | null;
    isRestSlot: boolean;
    skipped: boolean;
    hasTrainingRecord: boolean;
    hasWorkoutCheckin: boolean;
    overtimeStart: string | null;
    remindersEnabled: boolean;
  };
  supplements: {
    id: number;
    name: string;
    doseText: string;
    times: string[];
    takenToday: boolean;
    verdict: { due: boolean; dueTime: string | null; reason: string };
  }[];
}

const REASON_TEXT: Record<string, string> = {
  disabled: "训练提醒关了 → 今天不发",
  recorded: "今天已练 / 已打卡 → 全天静默",
  holiday: "法定节假日 → 不发训练提醒",
  rest: "循环位「休」 → 不发训练提醒",
  skipped: "今天已顺延 → 发「已顺延 + 一键确认」",
  overtime_ok: "加班到 22:30 之后 → 豁免，不催",
  overtime_late: "加班赶不上 → 建议顺延 + 一键顺延",
  prompt: "无记录无豁免 → 正常催练 + 一键打卡",
};

const ACTION_TEXT: Record<string, string> = {
  checkin: "一键打卡（POST /api/v1/checkin）",
  skip: "一键顺延（POST /api/v1/skip）",
  ack: "只需知道（不用动作）",
};

const SUPPLEMENT_REASON: Record<string, string> = {
  taken: "已打卡 → 今天不再提",
  not_yet: "还没到点",
  already_sent: "已经发过（去重命中）",
  due: "到点该提",
};

export default function ReminderPreviewPage() {
  const router = useRouter();
  const [at, setAt] = useState("22:30");

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["reminders", "preview", at],
    queryFn: () => api.get<PreviewPayload>(`/api/v1/reminders/preview?at=${encodeURIComponent(at)}`),
  });

  return (
    <main>
      <button className="tap-ghost mb-2 text-[13px] text-accent" onClick={() => router.push("/settings")}>
        ← 返回
      </button>
      <h1 className="text-xl font-bold">提醒预览 · 演练一遍判定</h1>
      <p className="muted mt-1 text-[12.5px] leading-relaxed">
        按 13.10 的判定表跑一遍，看这个时刻到底会不会发、发什么。
        <span className="font-semibold">只读</span>：不生成事件、不写去重与投递记录。
      </p>

      <Card className="mt-3">
        <div className="text-[13px] font-semibold">演练时刻（当天 {data?.date ?? ""}）</div>
        {/* 窄屏（390 / 320px）别把按钮字挤成竖排（issue #12 的同类炸点）：允许换行，不压按钮宽度 */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="time"
            className="input h-10 w-32 py-1 text-center text-[15px]"
            value={at}
            onChange={(e) => e.target.value && setAt(e.target.value)}
          />
          <button type="button" className="btn btn-secondary min-h-[38px] px-3 text-[12.5px]" onClick={() => void refetch()}>
            {isFetching ? "算一遍…" : "再算一遍"}
          </button>
          <button
            type="button"
            className="btn btn-secondary min-h-[38px] px-3 text-[12.5px]"
            onClick={() => setAt(data?.checkTime ?? "22:30")}
          >
            提醒时间 {data?.checkTime ?? ""}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["21:00", "22:00", "22:29", "22:30", "23:00", "23:59"].map((t) => (
            <button
              key={t}
              type="button"
              className={`tap rounded-lg border px-2.5 text-[12px] ${
                at === t ? "border-accent bg-accent-soft font-semibold" : "border-border"
              }`}
              onClick={() => setAt(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </Card>

      {isLoading && <div className="card mt-3 h-40 animate-pulse" />}
      {!isLoading && !data && <Empty>算不出来（接口没通？）</Empty>}

      {data && (
        <>
          <Card className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[15px] font-semibold">结论</div>
              <Pill tone={data.decision.verdict === "send" ? "accent" : "plain"}>
                {data.decision.verdict === "send" ? "会发" : "静默"}
              </Pill>
            </div>
            <div className="mt-1.5 text-[13px] leading-relaxed">
              {REASON_TEXT[data.decision.reason] ?? data.decision.reason}
              {data.decision.beforeCheckTime && (
                <span className="muted"> · 注意：这个时刻还没到判定时刻（{data.checkTime}）</span>
              )}
            </div>
            {data.decision.verdict === "send" && (
              <>
                <Divider />
                <div className="text-[13.5px] font-semibold">{data.decision.title}</div>
                <div className="mt-1 text-[13px] leading-relaxed">{data.decision.body}</div>
                {data.decision.action && (
                  <div className="muted mt-1.5 text-[11.5px]">带的动作：{ACTION_TEXT[data.decision.action]}</div>
                )}
              </>
            )}
          </Card>

          <Card className="mt-3">
            <div className="text-[13px] font-semibold">判定链（命中即结论，不再往下判）</div>
            <div className="mt-2 space-y-1.5">
              {data.decision.steps.map((step) => (
                <div key={step.no} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
                  <span className={`mt-[1px] w-4 shrink-0 text-center ${step.hit ? "text-accent" : "text-muted"}`}>
                    {step.hit ? "●" : "○"}
                  </span>
                  <span className={step.no === data.decision.hitNo ? "font-semibold" : ""}>
                    {step.no}. {step.name}
                    <span className="muted"> —— {step.detail}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="muted mt-2 text-[11.5px]">
              加班判据固定 22:30（3.3 / 13.11），与「提醒时间」这个配置项无关。
            </p>
          </Card>

          <Card className="mt-3">
            <div className="text-[13px] font-semibold">判定输入（这就是为什么是这个结论）</div>
            <div className="mt-2 space-y-1 text-[12.5px]">
              <Row label="今天该练" value={data.input.isRestSlot ? "休" : data.input.partLabel || "—"} />
              <Row label="明天该练" value={data.input.nextPartLabel || "—"} />
              <Row label="法定节假日" value={data.input.holidayName ?? "不是"} />
              <Row label="训练记录（含 doing）" value={data.input.hasTrainingRecord ? "有" : "没有"} />
              <Row label="workout 打卡" value={data.input.hasWorkoutCheckin ? "打了" : "没打"} />
              <Row label="已顺延" value={data.input.skipped ? "是" : "否"} />
              <Row label="最早加班开始" value={data.input.overtimeStart ?? "今天没有加班"} />
              <Row label="训练提醒总开关" value={data.input.remindersEnabled ? "开着" : "已关闭"} />
            </div>
          </Card>

          <Card className="mt-3">
            <div className="text-[13px] font-semibold">补剂（第 2 条：没打卡才提）</div>
            {data.supplements.length === 0 ? (
              <p className="muted mt-2 text-[12.5px]">还没配补剂（我的 → 补剂清单）。</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {data.supplements.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="min-w-0">
                      <span className="font-medium">{s.name}</span>
                      <span className="muted ml-1.5">{s.times.join(" / ")}</span>
                    </span>
                    <span className="shrink-0">
                      <Pill tone={s.verdict.due ? "accent" : "plain"}>
                        {SUPPLEMENT_REASON[s.verdict.reason] ?? s.verdict.reason}
                      </Pill>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="muted mt-2 text-[11.5px]">
              演练不跟踪「今天是不是已经发过」那条去重：真实投递以定时 tick 与 reminders/due 接口为准。
            </p>
          </Card>

          <p className="muted mt-4 text-center text-[11.5px]">
            这次演练写了 0 条事件、0 条投递记录 —— 想验证真实投递，去看 `GET /api/v1/reminders/due`。
          </p>
        </>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
