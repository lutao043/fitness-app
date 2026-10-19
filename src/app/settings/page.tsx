"use client";

/**
 * 我的（阶段 4 最小集）：登录态 / 改密码 / 单位（kg-lb）/ 提醒时间与总开关 /
 * 假期表（**只读**展示，FR-24 / 13.12 不给任何手工编辑或催办入口）/ 导出与备份恢复（v1.1）/ 退出。
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  qk,
  type OvertimeRow,
  type SettingsPayload,
  type SupplementRow,
} from "@/client/api";
import { useConfirm } from "@/components/confirm";
import { OvertimeEditor, type OvertimeDraft } from "@/components/overtime-editor";
import { useToast } from "@/components/toast";
import { Card, Divider, Pill, Row, SectionTitle, Sheet } from "@/components/ui";
import { OVERTIME_QUICK_TIMES, overtimeDateLabel } from "@/lib/overtime";
import { supplementDayKindLabel } from "@/lib/reminder/date-kind";
import { dateInTz } from "@/lib/time";

interface SupplementForm {
  id: number | null;
  name: string;
  times: string[];
  doseText: string;
  enabled: boolean;
  /** 适用日（v1.49 / 13.21）：daily 默认 = 每天（= 分档前行为） */
  dayKind: "daily" | "workday" | "restday";
}

const COMMON_TIMES = ["08:30", "09:30", "12:10", "13:30", "18:30", "22:30"];

export default function SettingsPage() {
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [reminderTime, setReminderTime] = useState<string | null>(null);
  /** 休息日档的待提交值（v1.49 / 13.21：周末 + 法定节假日走它） */
  const [reminderTimeRestday, setReminderTimeRestday] = useState<string | null>(null);
  const [supplementForm, setSupplementForm] = useState<SupplementForm | null>(null);
  const [cheatInterval, setCheatInterval] = useState<number | null>(null);
  /** 加班面板（FR-22 / §12.1：补录历史、录明天、改，与今日页共用同一个面板） */
  const [overtimeEdit, setOvertimeEdit] = useState<OvertimeDraft | null>(null);
  const [overtimeExpanded, setOvertimeExpanded] = useState(false);
  /** 新生成的助手 token：明文只在这一屏出现一次（库里只有哈希） */
  const [newToken, setNewToken] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const { data: settings } = useQuery({
    queryKey: qk.settings(),
    queryFn: () => api.get<SettingsPayload>("/api/v1/settings"),
  });
  const { data: supplements } = useQuery({
    queryKey: qk.supplements(),
    queryFn: () => api.get<{ supplements: SupplementRow[] }>("/api/v1/supplements"),
  });
  const { data: holidayPayload } = useQuery({
    queryKey: qk.holidays(),
    queryFn: () =>
      api.get<{
        years: number[];
        days: { date: string; name: string; type: "holiday" | "workday" }[];
        coverage: { end: string | null; text: string };
        meta: { updatedAt: string | null; source: string | null };
      }>("/api/v1/holidays"),
  });
  const holidays = holidayPayload;
  const { data: overtimeList } = useQuery({
    queryKey: qk.overtimes(),
    queryFn: () =>
      api.get<{ overtimes: OvertimeRow[]; dayTypes?: Record<string, "training" | "rest" | "holiday"> }>(
        "/api/v1/overtime?limit=30",
      ),
  });
  const { data: tokenStatus } = useQuery({
    queryKey: qk.apiToken(),
    queryFn: () => api.get<{ envConfigured: boolean; dbConfigured: boolean }>("/api/v1/settings/api-token"),
  });

  /**
   * 加班面板的保存（FR-22 / §12.4）：新建走 POST（补录历史、录明天），编辑走 PATCH ——
   * 「改时间不用删了重录」就是这条路径；失败时面板不关，toast 报原因。
   */
  const saveOvertime = useMutation({
    mutationFn: (draft: OvertimeDraft) =>
      draft.id === null
        ? api.post("/api/v1/overtime", { date: draft.date, start: draft.start, note: draft.note ?? undefined })
        : api.patch("/api/v1/overtime", { id: draft.id, date: draft.date, start: draft.start, note: draft.note }),
    onSuccess: async (_res, draft) => {
      setOvertimeEdit(null);
      toast.show(draft.id === null ? "加班记下了 · 当天判定立刻重算" : "改好了 · 当天判定立刻重算");
      await queryClient.invalidateQueries({ queryKey: qk.overtimes() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没保存上"),
  });

  /* ——— 助手接口 token（需求书第 7 章：单用户 token，设置页可重置） ——— */

  const rotateToken = useMutation({
    mutationFn: () => api.post<{ token: string }>("/api/v1/settings/api-token"),
    onSuccess: async (res) => {
      setNewToken(res.token);
      await queryClient.invalidateQueries({ queryKey: qk.apiToken() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "生成失败"),
  });

  const clearToken = useMutation({
    mutationFn: () => api.del("/api/v1/settings/api-token"),
    onSuccess: async () => {
      toast.show("库里那个 token 已清除");
      await queryClient.invalidateQueries({ queryKey: qk.apiToken() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "清除失败"),
  });

  const removeOvertime = useMutation({
    mutationFn: (id: number) => api.del(`/api/v1/overtime?id=${id}`),
    onSuccess: async (_res, id) => {
      await queryClient.invalidateQueries({ queryKey: qk.overtimes() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      toast.show("已删除加班记录", {
        label: "撤销",
        onAction: async () => {
          const row = overtimeList?.overtimes.find((o) => o.id === id);
          if (row) {
            await api.post("/api/v1/overtime", { date: row.date, start: row.startTime, note: row.note ?? undefined });
            await queryClient.invalidateQueries({ queryKey: qk.overtimes() });
            await queryClient.invalidateQueries({ queryKey: qk.today() });
          }
        },
      });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "删除失败"),
  });

  const patchSettings = useMutation({
    mutationFn: (body: Partial<SettingsPayload> & { cheatIntervalDays?: number }) =>
      api.patch<SettingsPayload>("/api/v1/settings", body),
    onSuccess: async (_res, variables) => {
      await queryClient.invalidateQueries({ queryKey: qk.settings() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      // 换单位要连带刷新所有带重量读数的页面（§1.1：只改展示层，库里仍是 kg）
      if (variables.unit !== undefined) {
        await queryClient.invalidateQueries({ queryKey: qk.body() });
        await queryClient.invalidateQueries({ queryKey: qk.stats() });
        await queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      toast.show("改好了，立即生效");
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "保存失败"),
  });

  /* ——— 补剂清单（FR-33：完全可增删改，改完提醒时点立即生效） ——— */

  const saveSupplement = useMutation({
    mutationFn: (payload: SupplementForm) => {
      const body = {
        name: payload.name.trim(),
        times: payload.times,
        dose_text: payload.doseText,
        enabled: payload.enabled,
        dayKind: payload.dayKind,
      };
      return payload.id === null
        ? api.post("/api/v1/supplements", body)
        : api.patch(`/api/v1/supplements/${payload.id}`, body);
    },
    onSuccess: async (_res, payload) => {
      setSupplementForm(null);
      toast.show(payload.id === null ? "补剂加好了 · 到点才会提" : "改好了 · 提醒时点跟着变");
      await queryClient.invalidateQueries({ queryKey: qk.supplements() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "保存失败"),
  });

  const supplementAction = useMutation({
    mutationFn: (action: { id: number; move?: "up" | "down"; enabled?: boolean; del?: boolean }) =>
      action.del
        ? api.del(`/api/v1/supplements/${action.id}`)
        : api.patch(`/api/v1/supplements/${action.id}`, {
            ...(action.move ? { move: action.move } : {}),
            ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.supplements() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没改成"),
  });

  /* ——— 放纵餐（FR-25：间隔在这里改，锚点靠「今天真吃了」挪） ——— */

  const cheatMeal = useMutation({
    mutationFn: () => api.post("/api/v1/cheat-meals", {}),
    onSuccess: async () => {
      toast.show("记下了 · 放纵餐锚点挪到今天，下一轮重新算");
      await queryClient.invalidateQueries({ queryKey: qk.settings() });
      await queryClient.invalidateQueries({ queryKey: qk.today() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没记上"),
  });

  // FR-47 上传恢复：二次确认在前端（页面内确认层，不用阻塞的 window.confirm），格式与完整性校验在服务端（13.13）——
  // 校验不过一个字节都不动；通过则整库替换 + 服务重启（容器 restart: unless-stopped 拉起）。
  const restoreMutation = useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch("/api/v1/restore", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      const body = (await res.json()) as { error?: string; applied?: boolean; message?: string };
      if (!res.ok) throw new Error(body.error ?? "恢复失败");
      return body;
    },
    onSuccess: (body) => {
      if (body.applied) {
        window.alert("备份已通过校验并恢复，服务正在重启。重启后需要用备份里的密码重新登录。");
        window.location.href = "/";
      } else {
        toast.show("备份校验通过（试运行，未实际写入）");
      }
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "恢复失败"),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post("/api/auth?action=setup", { password }),
    onSuccess: () => {
      setPassword("");
      toast.show("密码已更新");
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "改密码失败"),
  });

  const upcoming = (holidays?.days ?? []).filter((d) => d.date >= new Date().toISOString().slice(0, 10));
  const nextFew = (upcoming.length > 0 ? upcoming : holidays?.days ?? []).slice(0, 6);
  // 加班记录：默认 6 条，更多的收起来（§12.1）；日期说法走 lib/overtime 的同一个函数
  const today = dateInTz();
  const overtimeRows = overtimeList?.overtimes ?? [];
  const visibleOvertime = overtimeExpanded ? overtimeRows : overtimeRows.slice(0, 6);
  const moreOvertime = Math.max(0, overtimeRows.length - 6);

  return (
    <main>
      <h1 className="text-xl font-bold">我的</h1>

      <SectionTitle>记录偏好</SectionTitle>
      <Card>
        <Row label="训练重量单位" value={settings?.unit ?? "kg"} />
        <div className="mt-2 flex gap-2">
          {(["kg", "lb"] as const).map((unit) => (
            <button
              key={unit}
              className={`btn ${settings?.unit === unit ? "btn-primary" : "btn-secondary"} flex-1 min-h-[42px]`}
              onClick={() => patchSettings.mutate({ unit })}
            >
              {unit === "kg" ? "公斤 kg" : "磅 lb"}
            </button>
          ))}
        </div>
        <p className="muted mt-2 text-[11.5px]">内部一律按 kg 存，展示层换算（围度固定 cm、体脂固定 %）</p>
      </Card>

      <SectionTitle>提醒</SectionTitle>
      <Card>
        <Row
          label="训练提醒总开关"
          value={
            <button
              className={`btn ${settings?.workoutReminderOn ? "btn-primary" : "btn-secondary"} min-h-[36px] px-3 text-[13px]`}
              onClick={() => patchSettings.mutate({ workoutReminderOn: !settings?.workoutReminderOn })}
            >
              {settings?.workoutReminderOn ? "开着" : "已关闭"}
            </button>
          }
        />
        <Divider />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">提醒时间 · 工作日</span>
          <input
            className="input h-10 w-28 py-1 text-center"
            type="time"
            aria-label="提醒时间 · 工作日"
            value={reminderTime ?? settings?.reminderTime ?? "22:30"}
            onChange={(e) => setReminderTime(e.target.value)}
            onBlur={() => {
              if (reminderTime && reminderTime !== settings?.reminderTime) {
                patchSettings.mutate({ reminderTime });
                setReminderTime(null);
              }
            }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-sm">提醒时间 · 周末 / 假期</span>
          <input
            className="input h-10 w-28 py-1 text-center"
            type="time"
            aria-label="提醒时间 · 周末 / 假期"
            value={reminderTimeRestday ?? settings?.reminderTimeRestday ?? "22:30"}
            onChange={(e) => setReminderTimeRestday(e.target.value)}
            onBlur={() => {
              if (reminderTimeRestday && reminderTimeRestday !== settings?.reminderTimeRestday) {
                patchSettings.mutate({ reminderTimeRestday });
                setReminderTimeRestday(null);
              }
            }}
          />
        </div>
        <p className="muted mt-2 text-[11.5px]">
          调休上班日按工作日档；法定节假日与循环位「休」本来就不发训练提醒（想在演练里看今天是哪种态，去下面「提醒预览」）。
          加班判据固定 22:30，不跟着这两档拨（训练 21:00 结束 + 回家洗澡）。
        </p>
        <Divider />
        {/* FR-55：判定演练 —— 只读，不写任何事件 / 投递记录 */}
        <button
          type="button"
          className="btn btn-secondary btn-block min-h-[40px] text-[13px]"
          onClick={() => router.push("/settings/reminder-preview")}
        >
          提醒预览 · 演练一遍判定
        </button>
      </Card>

      {/* 补剂清单（FR-33：可增删改、可排序、可停用；「没打卡才提」由提醒 tick 读这张表） */}
      <Card className="mt-3">
        <Row
          label="补剂清单"
          value={<span className="muted text-[12px]">没打卡才提 · 改完立即生效</span>}
        />
        <Divider />
        {(supplements?.supplements.length ?? 0) === 0 ? (
          <p className="muted text-[12.5px]">还没有补剂 · 点下面加一条</p>
        ) : (
          <div className="space-y-1.5">
            {supplements?.supplements.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-xl border border-border px-2.5 py-1.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() =>
                    setSupplementForm({
                      id: s.id,
                      name: s.name,
                      times: s.times,
                      doseText: s.doseText,
                      enabled: s.enabled,
                      dayKind: s.dayKind,
                    })
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px]">{s.name}</span>
                    {!s.enabled && <Pill tone="plain">已停用</Pill>}
                  </span>
                  <span className="muted block truncate text-[11px]">
                    {s.times.length > 0 ? s.times.join(" / ") : "未设时点"}
                    {s.dayKind !== "daily" ? ` · ${supplementDayKindLabel(s.dayKind)}` : ""}
                    {s.doseText ? ` · ${s.doseText}` : ""}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`把 ${s.name} 往上挪`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                    onClick={() => supplementAction.mutate({ id: s.id, move: "up" })}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`把 ${s.name} 往下挪`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                    onClick={() => supplementAction.mutate({ id: s.id, move: "down" })}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2 text-[12px]"
                    onClick={() => supplementAction.mutate({ id: s.id, enabled: !s.enabled })}
                  >
                    {s.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    aria-label={`删掉补剂 ${s.name}`}
                    className="tap rounded-lg border border-border px-2 text-[12px] text-alert"
                    onClick={async () => {
                      if (
                        !(await confirmDialog({
                          title: `删掉「${s.name}」？`,
                          body: "清单里去掉它，今天还没投递的补剂提醒也一起清掉；打卡记录留着。",
                          danger: true,
                          confirmLabel: "删掉",
                        }))
                      ) {
                        return;
                      }
                      supplementAction.mutate({ id: s.id, del: true });
                    }}
                  >
                    删
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="btn btn-secondary btn-block mt-3"
          onClick={() =>
            setSupplementForm({ id: null, name: "", times: [], doseText: "", enabled: true, dayKind: "daily" })
          }
        >
          + 加一种补剂
        </button>
      </Card>

      <SectionTitle>训练排期</SectionTitle>

      {/* 当前方案：展示 + 进「规则管理」改（v1.2：方案 / 槽位 / 动作库） */}
      {settings?.scheme && (
        <Card className="mb-3">
          <Row
            label="当前方案"
            value={
              <span className="font-semibold">
                {settings.scheme.name} · 第 {settings.scheme.slotIndex + 1}/{settings.scheme.cycleLen} 位
              </span>
            }
          />
          <Divider />
          <div className="flex flex-wrap items-center gap-1.5">
            {settings.scheme.slots.map((s, i) => (
              <span key={`${s.label}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && <span className="muted text-[11px]">→</span>}
                <span
                  className={`tap rounded-lg border px-2 text-[12px] ${
                    i === settings.scheme.slotIndex
                      ? "border-accent bg-accent-soft font-semibold"
                      : "border-border"
                  }`}
                >
                  {s.rest ? "休" : s.label}
                </span>
              </span>
            ))}
          </div>
          <p className="muted mt-2 text-[11.5px]">
            锚点 {settings.scheme.anchorDate}（第 {settings.scheme.anchorPosition + 1} 位）· 停练 ≥ 3 个训练日时会先问要不要
            重锚，未确认前排期不变；法定节假日不占循环位。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="btn btn-secondary min-h-[42px] text-[13.5px]" onClick={() => router.push("/settings/scheme")}>
              方案与槽位编辑
            </button>
            <button
              className="btn btn-secondary min-h-[42px] text-[13.5px]"
              onClick={() => router.push("/settings/exercises")}
            >
              动作库与器械变体
            </button>
          </div>
          <p className="muted mt-2 text-[11.5px]">循环长度 = 槽位数；换方案是显式操作，不动 3.2 的排期语义。</p>
        </Card>
      )}

      {/* 放纵餐（FR-25 / 3.4）：只提醒不强制，文案永远只陈述事实 */}
      <Card className="mb-3">
        <Row
          label="放纵餐间隔"
          value={
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="减少间隔天数"
                className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                onClick={() => setCheatInterval(Math.max(1, (cheatInterval ?? settings?.cheat.intervalDays ?? 8) - 1))}
              >
                −
              </button>
              <span className="w-12 text-center">{cheatInterval ?? settings?.cheat.intervalDays ?? 8} 天</span>
              <button
                type="button"
                aria-label="增加间隔天数"
                className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                onClick={() => setCheatInterval(Math.min(60, (cheatInterval ?? settings?.cheat.intervalDays ?? 8) + 1))}
              >
                +
              </button>
            </span>
          }
        />
        {cheatInterval !== null && cheatInterval !== settings?.cheat.intervalDays && (
          <button
            className="btn btn-primary btn-block mt-2 min-h-[40px] text-[13px]"
            onClick={() => {
              patchSettings.mutate({ cheatIntervalDays: cheatInterval });
              setCheatInterval(null);
            }}
          >
            保存为 {cheatInterval} 天
          </button>
        )}
        <p className="muted mt-2 text-[11.5px] leading-relaxed">
          锚点 = 最近一次真的吃了的那天：{settings?.cheat.lastLogDate ?? "还没有记录"}（共 {settings?.cheat.logCount ?? 0} 次）。
          「8 天一轮」原是照 4 天循环定的，换方案后两个循环变成 2N 天，改不改你定。
        </p>
        <button
          className="btn btn-secondary btn-block mt-2"
          disabled={cheatMeal.isPending}
          onClick={() => cheatMeal.mutate()}
        >
          今天真吃了（锚点挪到今天）
        </button>
      </Card>

      {/* 加班记录全量维护（3.3 / FR-22：补录历史、改、删、录明天；录入在首页一点即录，§12.1） */}
      <Card className="mb-3">
        <Row
          label="加班记录"
          value={<span className="muted text-[12px]">判据固定 22:30 · 多条取开始最早</span>}
        />
        <Divider />
        {overtimeRows.length > 0 ? (
          <>
            <div className="space-y-4">
              {visibleOvertime.map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0">
                    <span className="font-medium">{overtimeDateLabel(o.date, today)}</span> ·{" "}
                    <span className="font-semibold">{o.startTime}</span>
                    {o.note ? <span className="muted ml-2 text-[12px]">{o.note}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-6">
                    <button
                      type="button"
                      className="tap-ghost text-[12.5px] text-accent underline underline-offset-2"
                      onClick={() => setOvertimeEdit({ id: o.id, date: o.date, start: o.startTime, note: o.note })}
                    >
                      改
                    </button>
                    <button
                      type="button"
                      className="tap-ghost text-[12.5px] text-alert underline underline-offset-2"
                      onClick={() => removeOvertime.mutate(o.id)}
                    >
                      删
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {moreOvertime > 0 && (
              <button
                type="button"
                className="btn btn-secondary btn-block mt-2 min-h-[36px] text-[12.5px]"
                onClick={() => setOvertimeExpanded((v) => !v)}
              >
                {overtimeExpanded ? "收起" : `还有 ${moreOvertime} 条更早的 · 展开`}
              </button>
            )}
          </>
        ) : (
          <p className="muted mt-2 text-[12px]">还没有加班记录 · 在首页点一下时间胶囊就能录今晚的</p>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-block mt-2"
          onClick={() => setOvertimeEdit({ id: null, date: today, start: OVERTIME_QUICK_TIMES[0], note: "" })}
        >
          + 添加（补录历史 / 录明天）
        </button>
      </Card>

      <Card>
        <Row
          label="假期 / 补班表"
          value={<Pill tone={holidays ? "ok" : "plain"}>覆盖到 {holidays?.coverage.text ?? "…"}</Pill>}
        />
        <Divider />
        <div className="space-y-1">
          {nextFew.map((d) => (
            <div key={d.date} className="flex items-center justify-between text-[13px]">
              <span>{d.date}</span>
              <span className="flex items-center gap-2">
                <span className="muted">{d.name}</span>
                <Pill tone={d.type === "workday" ? "warn" : "plain"}>
                  {d.type === "workday" ? "补班" : "放假"}
                </Pill>
              </span>
            </div>
          ))}
        </div>
        <p className="muted mt-3 text-[11.5px] leading-relaxed">
          最近更新于 {holidays?.meta.updatedAt?.slice(0, 10) ?? "—"} · 来源{" "}
          {holidays?.meta.source
            ? holidays.meta.source === "seed"
              ? "安装种子"
              : holidays.meta.source === "assistant"
                ? "助手"
                : holidays.meta.source
            : "—"}
          <br />
          这张表由助手写入，网页只读（两个写入口必然打架）。覆盖期不足时首页会出提示条。
        </p>
      </Card>

      <SectionTitle>数据与账号</SectionTitle>
      <Card>
        <a className="btn btn-secondary btn-block" href="/api/v1/export.json" target="_blank" rel="noreferrer">
          导出全量 JSON
        </a>
        {/* FR-46：CSV 分开导出、带 UTF-8 BOM（13.13），Excel 直接打开不乱码 */}
        <div className="mt-2 grid grid-cols-3 gap-2">
          <a className="btn btn-secondary text-[12.5px]" href="/api/v1/export.csv?type=workout" download>
            训练 CSV
          </a>
          <a className="btn btn-secondary text-[12.5px]" href="/api/v1/export.csv?type=body" download>
            身体 CSV
          </a>
          <a className="btn btn-secondary text-[12.5px]" href="/api/v1/export.csv?type=measurements" download>
            围度 CSV
          </a>
        </div>
        <p className="muted mt-2 text-[11.5px]">
          CSV 带 BOM；重量列是面板单侧读数、另有折算总重列（13.1 / 13.13）
        </p>

        {/* FR-47：备份下载 + 上传恢复（前端二次确认 + 服务端格式校验，13.13 的恢复流程） */}
        <Divider />
        <a className="btn btn-secondary btn-block" href="/api/v1/backup" download>
          下载数据库备份（.sqlite）
        </a>
        <p className="muted mt-2 text-[11.5px]">
          备份是 VACUUM 生成的一致性快照（13.13）；这份同时会留在容器的备份目录里，保留最近 30 份。
        </p>

        <Divider />
        <input
          ref={restoreInputRef}
          type="file"
          accept=".sqlite,.db,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void confirmDialog({
              title: "确定用这份备份整库覆盖当前数据吗？",
              body: "备份之后记的都会没掉；恢复通过校验后服务会自动重启，要用备份里的密码重新登录。",
              danger: true,
              confirmLabel: "覆盖恢复",
            }).then((ok) => {
              if (ok) restoreMutation.mutate(file);
            });
          }}
        />
        <button
          className="btn btn-danger btn-block"
          disabled={restoreMutation.isPending}
          onClick={() => restoreInputRef.current?.click()}
        >
          {restoreMutation.isPending ? "校验并恢复中…" : "上传备份恢复…"}
        </button>
        <p className="muted mt-2 text-[11.5px]">
          恢复 = **整库覆盖**：先校验（文件头 + 完整性 + 表结构），校验不过一个字节都不动；通过后原子替换并重启服务。
        </p>

        <Divider />
        <div className="flex items-center gap-2">
          <input
            className="input"
            type="password"
            placeholder="新密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="btn btn-secondary shrink-0"
            disabled={password.length < 6 || changePassword.isPending}
            onClick={() => changePassword.mutate()}
          >
            改密码
          </button>
        </div>

        {/* 助手接口 token（需求书第 7 章 / D2：单用户 token，设置页可重置） */}
        <Divider />
        <Row
          label="助手接口 token"
          value={
            tokenStatus === undefined ? (
              <Pill tone="plain">…</Pill>
            ) : tokenStatus.dbConfigured ? (
              <Pill tone="ok">已配置</Pill>
            ) : tokenStatus.envConfigured ? (
              <Pill tone="plain">只认环境变量</Pill>
            ) : (
              <Pill tone="warn">未配置</Pill>
            )
          }
        />
        <p className="muted mt-2 text-[11.5px] leading-relaxed">
          助手调 <span className="font-mono">/api/v1/*</span> 时带请求头{" "}
          <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>。生成的新 token 与库里只存哈希，
          <b>明文只在生成那一次显示</b>，忘了就再生成一个。
          {tokenStatus?.envConfigured
            ? " 部署脚本里配了 API_TOKEN（环境变量优先，改它得动 .env 并重启容器）。"
            : ""}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn btn-secondary min-h-[42px] text-[13px]"
            disabled={rotateToken.isPending}
            onClick={async () => {
              if (
                !(await confirmDialog({
                  title: "生成一个新的助手 token？",
                  body: tokenStatus?.dbConfigured
                    ? "库里那个立刻失效 —— 记得把新 token 换到助手脚本里，不然助手会一直 401。"
                    : "生成后把它填进助手脚本（请求头 Authorization: Bearer …）。",
                  confirmLabel: "生成",
                }))
              ) {
                return;
              }
              rotateToken.mutate();
            }}
          >
            生成新 token
          </button>
          <button
            type="button"
            className="btn btn-secondary min-h-[42px] text-[13px] text-alert"
            disabled={!tokenStatus?.dbConfigured || clearToken.isPending}
            onClick={async () => {
              if (
                !(await confirmDialog({
                  title: "清掉库里的助手 token？",
                  body: "清掉后助手再用旧 token 会 401；.env 里的 API_TOKEN 不受影响。",
                  danger: true,
                  confirmLabel: "清除",
                }))
              ) {
                return;
              }
              clearToken.mutate();
            }}
          >
            清除
          </button>
        </div>

        <Divider />
        <button
          className="btn btn-secondary btn-block"
          onClick={async () => {
            if (!(await confirmDialog({ title: "退出登录？", body: "下次访问要重新输密码。" }))) return;
            await api.post("/api/auth?action=logout");
            router.push("/login");
          }}
        >
          退出登录
        </button>
      </Card>

      <p className="muted mt-4 text-center text-[11.5px]">
        自托管 · 数据在自己的服务器上 · 版本 MVP（排期 + 训练记录 + 体重 + 一键打卡）
      </p>

      {/* 补剂编辑（FR-33）：名称 / 时点 / 剂量 / 启用；时点用胶囊点选，少打字 */}
      <Sheet
        open={supplementForm !== null}
        title={supplementForm?.id === null ? "加一种补剂" : `编辑「${supplementForm?.name ?? ""}」`}
        onClose={() => setSupplementForm(null)}
      >
        {supplementForm && (
          <>
            <label className="muted text-[12px]">名称</label>
            <input
              className="input mt-1 h-10"
              value={supplementForm.name}
              onChange={(e) => setSupplementForm({ ...supplementForm, name: e.target.value })}
            />
            <div className="muted mt-3 mb-1.5 text-[12px]">提醒时点（点一下加/去掉；到点没打卡才提）</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[...new Set([...COMMON_TIMES, ...supplementForm.times])].map((time) => (
                <button
                  key={time}
                  type="button"
                  aria-pressed={supplementForm.times.includes(time)}
                  className={`tap rounded-lg border px-2.5 text-[12.5px] ${
                    supplementForm.times.includes(time) ? "border-accent bg-accent-soft font-semibold" : "border-border"
                  }`}
                  onClick={() =>
                    setSupplementForm({
                      ...supplementForm,
                      times: supplementForm.times.includes(time)
                        ? supplementForm.times.filter((t) => t !== time)
                        : [...supplementForm.times, time].sort(),
                    })
                  }
                >
                  {time}
                </button>
              ))}
              <input
                className="input h-9 w-24 py-1 text-center"
                type="time"
                aria-label="自定义提醒时点"
                onChange={(e) => {
                  const time = e.target.value;
                  if (!time) return;
                  setSupplementForm({
                    ...supplementForm,
                    times: supplementForm.times.includes(time)
                      ? supplementForm.times
                      : [...supplementForm.times, time].sort(),
                  });
                }}
              />
            </div>
            <p className="muted mt-1.5 text-[11px]">
              当前：{supplementForm.times.length > 0 ? supplementForm.times.join(" / ") : "未设时点（不会提醒）"}
            </p>
            {/* 适用日（v1.49 / 13.21）：只影响提醒；调休上班日算工作日；默认每天 = 分档前行为 */}
            <div className="muted mt-3 mb-1.5 text-[12px]">适用日（只影响提醒，打卡不受限）</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(["daily", "workday", "restday"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={supplementForm.dayKind === k}
                  className={`tap rounded-lg border px-2.5 text-[12.5px] ${
                    supplementForm.dayKind === k ? "border-accent bg-accent-soft font-semibold" : "border-border"
                  }`}
                  onClick={() => setSupplementForm({ ...supplementForm, dayKind: k })}
                >
                  {supplementDayKindLabel(k)}
                </button>
              ))}
            </div>
            <p className="muted mt-1.5 text-[11px]">
              「仅工作日」在调休上班日照发、「仅休息日」在周末与法定节假日发；不设 = 每天（和以前一样）
            </p>
            <label className="muted mt-3 block text-[12px]">剂量文案（如「1 粒 · 早餐随餐」）</label>
            <input
              className="input mt-1 h-10"
              value={supplementForm.doseText}
              onChange={(e) => setSupplementForm({ ...supplementForm, doseText: e.target.value })}
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[13px]">启用（关掉就不提醒了）</span>
              <button
                type="button"
                className={`btn ${supplementForm.enabled ? "btn-primary" : "btn-secondary"} min-h-[36px] px-3 text-[12.5px]`}
                onClick={() => setSupplementForm({ ...supplementForm, enabled: !supplementForm.enabled })}
              >
                {supplementForm.enabled ? "启用中" : "已停用"}
              </button>
            </div>
            <button
              className="btn btn-primary btn-block mt-4 min-h-[46px]"
              disabled={supplementForm.name.trim().length === 0 || saveSupplement.isPending}
              onClick={() => saveSupplement.mutate(supplementForm)}
            >
              {supplementForm.id === null ? "加进清单" : "保存"}
            </button>
          </>
        )}
      </Sheet>

      {/* 加班面板（FR-22 / §12.1）：补录历史 / 录明天 / 改，与今日页共用同一个面板；删沿用带撤销的那条路径 */}
      <OvertimeEditor
        draft={overtimeEdit}
        onClose={() => setOvertimeEdit(null)}
        onSubmit={(draft) => saveOvertime.mutate(draft)}
        // 13.11 / v1.20：休息日的加班只作记录 —— 行的 dayType 与今天 / 明天的类型都在这个响应里
        dayTypeOf={(date) =>
          overtimeList?.dayTypes?.[date] ??
          overtimeRows.find((o) => o.date === date)?.dayType ??
          null
        }
        onDelete={(draft) => {
          if (draft.id === null) return;
          setOvertimeEdit(null);
          removeOvertime.mutate(draft.id);
        }}
      />

      {/* 新 token 只显示这一次：库里存的是 argon2 哈希，关掉这个面板就找不回明文了 */}
      <Sheet open={newToken !== null} title="新 token · 只显示这一次" onClose={() => setNewToken(null)}>
        <p className="muted text-[12px] leading-relaxed">
          复制到助手脚本里（请求头 <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>）。
          关掉这个面板就再也看不到了 —— 库里只存哈希，忘了就再生成一个。
        </p>
        <div className="mt-3 rounded-xl border border-border bg-bg p-3 font-mono text-[12.5px] break-all">
          {newToken}
        </div>
        <button
          className="btn btn-primary btn-block mt-3 min-h-[44px]"
          onClick={async () => {
            if (!newToken) return;
            try {
              await navigator.clipboard.writeText(newToken);
              toast.show("已复制 · 记得换到助手脚本里");
            } catch {
              toast.show("复制不了（浏览器没给权限）· 长按上面的文本手动复制");
            }
          }}
        >
          复制
        </button>
        <button className="btn btn-secondary btn-block mt-2 min-h-[42px]" onClick={() => setNewToken(null)}>
          我记下了
        </button>
      </Sheet>
    </main>
  );
}
