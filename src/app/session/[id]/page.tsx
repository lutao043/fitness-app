"use client";

/**
 * 逐组训练（FR-7~FR-12 / FR-41 / FR-42 / FR-43）。
 *
 * 设计要点（都对得上出处）：
 * - 记组卡**三态**（FR-9 v1.50 / issue #75）：待开始（【开始这组】）→ 进行中（大号本组计时 +【结束这组】）
 *   → 落库成功才进休息倒计时；点【开始这组】不起倒计时；
 * - 组间歇用**绝对时间戳 rest_end 反算**，不累加（第 9 章第 7 条：锁屏后定时器会被节流）；
 * - 一组记完、清单里还有待做动作才起倒计时；**最后一组直接进收工态**（FR-12 v1.50 / issue #77），
 *   判定用落库后的服务端数据，不在点按钮前预判；
 * - 暂停时长只累计到 pausedMs 里、写入时由服务端从两侧扣一次（FR-42 / 13.5）；
 * - 每组落库（服务端按 `started_at` → `done_at` 算 rest_before_sec 与 same_exercise），
 *   切走 / 锁屏 / 杀进程回来都还在（FR-41）；
 * - 训练中**不做必填校验**，任何一步都能留空直接过（第 12 章第 14 条）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, qk, type ExerciseLibraryRow, type SessionDetail } from "@/client/api";
import { ExercisePicker } from "@/components/exercise-picker";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Card, Divider, Empty, Sheet, Stepper } from "@/components/ui";
import { setClientKey } from "@/lib/set-key";
import {
  DOING_TIMEOUT_MS,
  doingElapsedSec,
  pauseRest,
  restRemainingSec,
  resumeRest,
  sessionPhase,
  stopRest,
  type SessionPhase,
} from "@/lib/session-rest";
import { pickEncouragement } from "@/lib/coach/pick";
import encouragements from "@/data/encouragements.json";
import { exerciseSetText, overallSetText, phaseAfterSet, setButtonLabel, shouldFinish } from "@/lib/session-progress";
import type { LoadMode } from "@/lib/exercise/types";
import {
  DEFAULT_REST_SEC,
  durationMinutesText,
  effectiveRestSec,
  REPS_RANGE,
  totalLoadKg,
  weightLabel,
  weightReadHint,
  weightSummaryText,
} from "@/lib/caliber";
import {
  displayToKg,
  effectiveReadUnit,
  formatWeight,
  kgToDisplay,
  volumeText,
  weightMax,
  weightStep,
} from "@/lib/units";

/** 每组感受（FR-11）：轻松 / 正常 / 吃力 / 力竭，**可以不标**（留空 = null） */
const FEEL_OPTIONS = [
  { value: "easy", label: "轻松" },
  { value: "normal", label: "正常" },
  { value: "hard", label: "吃力" },
  { value: "failure", label: "力竭" },
] as const;
type FeelValue = (typeof FEEL_OPTIONS)[number]["value"];

interface LocalState {
  draft: Record<
    string,
    { weight?: number; reps?: number; duration?: number; variantId?: number | null; feel?: FeelValue | null }
  >;
  restEnd: number | null;
  /**
   * 暂停时冻结的剩余毫秒（issue #33 / v1.39）：暂停 = 把"还剩多少"接住再清空 restEnd；
   * 继续 = 按它重算终点。老 localStorage 里没有这个字段 → 按 undefined 兜底（视为"没在暂停"）。
   */
  restRemainMs?: number | null;
  /**
   * 本组开始时刻（issue #75 / v1.50）：进行中态的唯一入口是【开始这组】；
   * 与倒计时一样**按绝对时间戳判定**（锁屏 / 冷启动回来秒数接着走）。老 localStorage 无此字段 → undefined。
   */
  setStartedAt?: number | null;
  /** 本次临时改过的组间歇（按动作记；FR-52 的优先级里最高） */
  restFor?: Record<string, number>;
  pausedMs: number;
  pauseStart: number | null;
  lastSetAt: number | null;
}

function loadLocal(sessionId: number): LocalState {
  const fallback: LocalState = {
    draft: {},
    restEnd: null,
    restRemainMs: null,
    setStartedAt: null,
    pausedMs: 0,
    pauseStart: null,
    lastSetAt: null,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`fitness-session-${sessionId}`);
    return raw ? { ...fallback, ...(JSON.parse(raw) as LocalState) } : fallback;
  } catch {
    return fallback;
  }
}

/** 训练页取数形状（日今日清单 + 组 + 预填） */
type SessionPayload = SessionDetail & {
  prefill: Record<string, Record<string, { weightKg: number | null; reps: number | null; durationSec: number | null }>>;
};

/** mm:ss（倒计时与本组计时共用同一形状；训练时长永远不到 1 小时的那类秒数不进这里） */
function clockText(totalSec: number): string {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

export default function SessionDoingPage() {
  const params = useParams<{ id: string }>();
  const sessionId = Number(params.id);
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<LocalState>(() => loadLocal(sessionId));
  const [finished, setFinished] = useState<SessionDetail["summary"] | null>(null);
  const [variantSheet, setVariantSheet] = useState(false);
  /** FR-10 的 doing 阶段：本次清单编辑（增删 / 换动作 / 先做这个 / 调本次目标） */
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 非空 = 选择器在「换一个」模式，选中的动作会替换这一条 */
  const [replaceTarget, setReplaceTarget] = useState<{ id: number; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 「已记下」窗口（issue #34）：落库成功后短暂禁用按钮，把手滑连点的窗口彻底关掉 */
  const [justRecorded, setJustRecorded] = useState(false);
  const recordedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 重量次要区（issue #35）：默认折叠成一行摘要，点开才展开加减器 */
  const [weightOpen, setWeightOpen] = useState(false);
  /** 收工态的「再练一组」（issue #39）：只存在内存里 —— 离开页面再回来仍按服务端数据判回收工态 */
  const [extraSetMode, setExtraSetMode] = useState(false);
  /** 倒计时留白那句（issue #33：词库 + 相邻不重复）；空态那句同理 */
  const [restLine, setRestLine] = useState<string | null>(null);
  const lastRestLineRef = useRef<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const soundedRef = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: qk.session(sessionId),
    queryFn: () => api.get<SessionPayload>(`/api/v1/sessions/${sessionId}`),
  });

  // 动作库只在打开选择器时取（91 条不必随训练页加载）
  const { data: lib } = useQuery({
    queryKey: qk.exercises(),
    queryFn: () =>
      api.get<{ exercises: ExerciseLibraryRow[]; taxonomy: { muscles: string[] } }>("/api/v1/exercises"),
    enabled: pickerOpen,
  });

  // 本地状态边练边落盘：刷新 / 锁屏回来接着练（FR-41）
  useEffect(() => {
    window.localStorage.setItem(`fitness-session-${sessionId}`, JSON.stringify(local));
  }, [sessionId, local]);

  // 组间歇倒计时：只用绝对时间戳反算，不累加
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  // 「已记下」窗口的定时器随页面卸载一起清掉
  useEffect(
    () => () => {
      if (recordedTimerRef.current) clearTimeout(recordedTimerRef.current);
    },
    [],
  );

  // 屏幕常亮（第 9 章第 7 条）：拿不到就算了，倒计时照走
  useEffect(() => {
    let released = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock
      ?.request("screen")
      .then((lock) => {
        if (released) void lock.release();
        else wakeLockRef.current = lock;
      })
      .catch(() => undefined);
    return () => {
      released = true;
      void wakeLockRef.current?.release().catch(() => undefined);
    };
  }, []);

  /**
   * 三态（FR-9 v1.50 / issue #75）：**态由绝对时间戳判定**（第 9 章第 7 条、第 12 章第 21 条）——
   * 冷启动 / 锁屏 / 切走 / 刷新回来都是同一套判定，不靠"刚才在哪个页"的内存标记。
   */
  const restState = {
    restEnd: local.restEnd,
    restRemainMs: local.restRemainMs ?? null,
    setStartedAt: local.setStartedAt ?? null,
  };
  const phase: SessionPhase = sessionPhase(restState, now);
  const remainingSec = restRemainingSec(restState, now);
  const doingSec = doingElapsedSec(restState, now);
  const paused = local.pauseStart !== null;

  // 进行中态挂太久（> 2 小时）= 僵尸态：自动回待开始，这一组不落库（FR-9 v1.50 / issue #75）
  useEffect(() => {
    const start = local.setStartedAt;
    if (start != null && (now < start || now - start >= DOING_TIMEOUT_MS)) {
      setLocal((prev) => ({ ...prev, setStartedAt: null }));
    }
  }, [local.setStartedAt, now]);

  /** 挑一句鼓励语（相邻不重复，池空有兜底）：每次进倒计时换一句 */
  const rollRestLine = useCallback((seed: number) => {
    const line = pickEncouragement(encouragements.rest, seed, lastRestLineRef.current);
    lastRestLineRef.current = line;
    setRestLine(line);
  }, []);
  // 冷启动 / 锁屏回来时已经处在倒计时态：补一句（同一场休息刷新页面结果稳定，种子用终点时间戳）
  useEffect(() => {
    if (phase === "rest" && !restLine) rollRestLine(local.restEnd ?? Date.now());
  }, [phase, restLine, local.restEnd, rollRestLine]);
  // 到点提示音 + 震动（尽力而为；外部渠道兜底、站内提醒是主路径）
  useEffect(() => {
    if (!local.restEnd) {
      soundedRef.current = false;
      return;
    }
    if (remainingSec === 0 && !soundedRef.current) {
      soundedRef.current = true;
      try {
        navigator.vibrate?.([180, 80, 180]);
      } catch {
        /* 忽略 */
      }
      const ctx = audioRef.current;
      if (ctx) {
        void ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    }
  }, [remainingSec, local.restEnd]);

  const exercises = useMemo(() => data?.exercises ?? [], [data?.exercises]);
  const sets = useMemo(() => data?.sets ?? [], [data?.sets]);
  /** 展示单位（§1.1）：库里一律 kg，界面按它换算（改设置后重新取数即生效） */
  const unit = data?.unit ?? "kg";
  /** 热身不算训练量（13.16）：v1.26 起不再记录热身组，这条排除只为历史行保留（进度 x/y 与收工判定只看正式组） */
  const workSets = useMemo(() => sets.filter((s) => !s.isWarmup), [sets]);
  const warmupCount = sets.length - workSets.length;

  const progress = useMemo(() => {
    const byExercise = new Map<number, number>();
    for (const s of workSets) byExercise.set(s.exerciseId, (byExercise.get(s.exerciseId) ?? 0) + 1);
    return byExercise;
  }, [workSets]);

  const totalTarget = exercises.reduce((sum, e) => sum + e.targetSets, 0);
  const doneSets = workSets.length;
  // 「当前动作」= 第一个没做满的动作；FR-10 编辑里点过「先做这个」的话，它排到了最前，自然就轮到它
  const current = exercises.find((e) => (progress.get(e.exerciseId) ?? 0) < e.targetSets) ?? exercises.at(-1) ?? null;
  // 本动作的组号与"做满没做满"（issue #37）：做满之后不再说"第 N 组"，按钮也收口
  const currentDoneSets = current ? (progress.get(current.exerciseId) ?? 0) : 0;
  const currentDone = !!current && currentDoneSets >= current.targetSets;
  /** 空态那句（issue #33）：动作都做完了 / 清单为空时给一句，别留一块空白 */
  const emptyLine = useMemo(
    () => pickEncouragement(encouragements.empty, totalTarget + doneSets),
    [totalTarget, doneSets],
  );
  /**
   * 收工态（issue #39 / v1.40）：**进入记组态时发现已无待做动作**（都做满 / 清单为空）→ 直接切收工态。
   * 判定用服务端数据（进度由已落库的组算出来），不靠"刚才点了什么"；**不自动收工** ——
   * 收工会派生自动打卡 / 循环推进 / 加练位点（13.20），必须他亲手点那一下。
   */
  const allDone = shouldFinish(
    exercises.map((e) => ({ doneSets: progress.get(e.exerciseId) ?? 0, targetSets: e.targetSets })),
    { extraSet: extraSetMode },
  );
  const inFinish = phase === "record" && allDone;

  /** 组间歇生效值（FR-52）：本次临时改档 > 动作级默认 > 会话默认 */
  const restSecFor = useCallback(
    (exercise: { exerciseId: number; restSec?: number | null } | null) =>
      effectiveRestSec({
        overrideSec: exercise ? (local.restFor ?? {})[String(exercise.exerciseId)] : null,
        exerciseRestSec: exercise?.restSec ?? null,
        sessionRestSec: data?.session.restTargetSec ?? DEFAULT_REST_SEC,
      }),
    [local.restFor, data?.session.restTargetSec],
  );

  /** 本次清单编辑（FR-10 doing 阶段）：加 / 移出 / 换动作 / 调顺序 / 调目标，全部只影响本次会话 */
  const editExercises = useMutation({
    mutationFn: async (action: {
      kind: "add" | "move" | "targets" | "swap" | "remove";
      id?: number;
      exerciseId?: number;
      sets?: number;
      reps?: number;
      move?: "up" | "down" | "first";
      confirm?: boolean;
    }) => {
      const base = `/api/v1/sessions/${sessionId}/exercises`;
      if (action.kind === "add") {
        return api.post(base, {
          exercise_id: action.exerciseId,
          target_sets: action.sets,
          target_reps: action.reps,
        });
      }
      if (action.kind === "remove") {
        return api.del(`${base}?id=${action.id}${action.confirm ? "&confirm=1" : ""}`);
      }
      return api.patch(base, {
        id: action.id,
        ...(action.kind === "move" ? { move: action.move } : {}),
        ...(action.kind === "swap" ? { exercise_id: action.exerciseId, confirm: action.confirm } : {}),
        ...(action.kind === "targets" ? { target_sets: action.sets, target_reps: action.reps } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没改成"),
  });

  /** 移出今天：已经记过组的要先确认（确认后那几组一起删，交互设计说明 §4.9） */
  const removeExercise = async (row: SessionDetail["exercises"][number]) => {
    try {
      await editExercises.mutateAsync({ kind: "remove", id: row.id });
      toast.show(`「${row.name}」移出今天了`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) return;
      const ok = await confirmDialog({
        title: `移出「${row.name}」？`,
        body: `${err.message} 移出后本次清单里就没有它了（模板不受影响）。`,
        danger: true,
        confirmLabel: "移出并丢掉那几组",
      });
      if (ok) {
        await editExercises.mutateAsync({ kind: "remove", id: row.id, confirm: true });
        toast.show(`「${row.name}」移出今天了`);
      }
    }
  };

  /** 换一个（同位置、目标保留）：已记过组的同样先确认 */
  const swapExercise = async (row: { id: number; name: string }, exerciseId: number) => {
    try {
      await editExercises.mutateAsync({ kind: "swap", id: row.id, exerciseId });
      toast.show("换好了 · 位置与目标组数都保留");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) return;
      const ok = await confirmDialog({
        title: "换掉这个动作？",
        body: err.message,
        danger: true,
        confirmLabel: "换掉并丢掉那几组",
      });
      if (ok) {
        await editExercises.mutateAsync({ kind: "swap", id: row.id, exerciseId, confirm: true });
        toast.show("换好了 · 位置与目标组数都保留");
      }
    }
  };

  /**
   * 这一组落库后还剩不剩动作（FR-12 v1.50 / issue #77）：用**落库后拉回来的服务端数据**判，
   * 不在点按钮前预判 —— 网络失败时预判会出现"以为做完就收工"的假收工；
   * `created: false` 的幂等重放也走同一条路（进度以服务端为准）。
   */
  const finishAfterThisSet = (payload: SessionPayload | undefined): boolean => {
    if (!payload) return false;
    const byExercise = new Map<number, number>();
    for (const s of payload.sets) {
      if (s.isWarmup) continue;
      byExercise.set(s.exerciseId, (byExercise.get(s.exerciseId) ?? 0) + 1);
    }
    return (
      phaseAfterSet(
        payload.exercises.map((e) => ({
          doneSets: byExercise.get(e.exerciseId) ?? 0,
          targetSets: e.targetSets,
        })),
      ) === "finish"
    );
  };

  const completeSet = useMutation({
    mutationFn: async (args: { exercise: NonNullable<typeof current> }) => {
      const key = String(args.exercise.exerciseId);
      const draft = local.draft[key] ?? {};
      const prefill = data?.prefill?.[key]?.[draft.variantId ? String(draft.variantId) : "default"];
      const setNo = (progress.get(args.exercise.exerciseId) ?? 0) + 1;
      const doneAt = Date.now();
      const pausedMsSincePrev = local.pausedMs;
      // 提交值 = 界面显示值（第 12 章「预填即所记」）：次数 / 秒数无草稿时兜底到目标值；
      // **重量不兜底**（FR-7 v1.37）：没填就是 null，不沿用上次、不拿参考重量顶替（空读数不计容量）；
      // 且按动作类型只记对应字段（重量动作记重量、计时动作记秒数），不写无关列
      return api.post<{ restBeforeSec: number | null; sameExercise: boolean; totalLoadKg: number | null }>(
        `/api/v1/sessions/${sessionId}/sets`,
        {
          // 幂等键必须是确定性的（issue #34）：同一组的两次点击 / 离线重放 / 重试都落到同一个键，
          // 服务端才认得出"这是同一组"（键尾以前带 doneAt，每点一次都变 → 连点两下记出两条）
          client_key: setClientKey({
            clientId: data?.session.clientId ?? sessionId,
            exerciseId: args.exercise.exerciseId,
            variantId: draft.variantId ?? null,
            setNo,
          }),
          exercise_id: args.exercise.exerciseId,
          set_no: setNo,
          variant_id: draft.variantId ?? null,
          weight_kg:
            args.exercise.type === "weight"
              ? // 不填 = null（FR-7 v1.37：不沿用上次、不猜、不补 0；空读数不计容量）
                (draft.weight ?? null)
              : null,
          reps:
            args.exercise.type === "time"
              ? null
              : (draft.reps ?? prefill?.reps ?? args.exercise.targetReps),
          duration_sec:
            args.exercise.type === "time"
              ? (draft.duration ?? prefill?.durationSec ?? args.exercise.targetReps)
              : null,
          // 本组开始时刻（FR-9 v1.50）：组间歇 = 上一组完成 → 本组开始，由服务端据此算 rest_before_sec；
          // 没点过【开始这组】就是 null（这一组不记组间歇，13.5）
          started_at: local.setStartedAt != null ? new Date(local.setStartedAt).toISOString() : null,
          done_at: new Date(doneAt).toISOString(),
          paused_ms_since_prev: pausedMsSincePrev,
          // 感受可留空（FR-11：可以不标；服务端只收 4 个枚举值）
          feel: draft.feel ?? null,
        },
      );
    },
    onSuccess: async (res, args) => {
      await queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
      // 落库成功后才判"还剩不剩动作"（issue #77）：没有待做动作 → 不起倒计时，直接进收工态
      const finishNow = finishAfterThisSet(queryClient.getQueryData<SessionPayload>(qk.session(sessionId)));
      // 感受每组各标各的：这一组入库后清掉草稿里的标记，下一组默认回到"不标感受"
      const justDone = String(args.exercise.exerciseId);
      // 「再练一组」的这一次请求已经兑现：复位后按服务端数据判回收工态（不再靠内存标记压着）
      setExtraSetMode(false);
      setLocal((prev) => {
        const rest = effectiveRestSec({
          overrideSec: (prev.restFor ?? {})[justDone],
          exerciseRestSec: args.exercise.restSec ?? null,
          sessionRestSec: data?.session.restTargetSec ?? DEFAULT_REST_SEC,
        });
        return {
          ...prev,
          draft: { ...prev.draft, [justDone]: { ...prev.draft[justDone], feel: null } },
          // 这一组结束了：清掉本组开始时刻与暂停残留
          setStartedAt: null,
          // 休息倒计时的唯一入口（FR-9 v1.50）：这一组落库成功且还有待做动作；最后一组不起倒计时
          restEnd: finishNow ? null : Date.now() + rest * 1000,
          restRemainMs: null,
          pauseStart: null,
          pausedMs: 0,
          lastSetAt: Date.now(),
        };
      });
      soundedRef.current = false;
      if (!finishNow) rollRestLine(Date.now() + 1);
      // 「已记下」态（issue #34）：这一组刚落地，短暂锁住按钮，连点不会走成第二次提交
      setJustRecorded(true);
      if (recordedTimerRef.current) clearTimeout(recordedTimerRef.current);
      recordedTimerRef.current = setTimeout(() => setJustRecorded(false), 1800);
      if (res?.totalLoadKg) {
        toast.show(`记下了 · 总重 ${formatWeight(res.totalLoadKg, readUnit)}`, undefined, 2200);
      } else {
        toast.show("记下了", undefined, 1800);
      }
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "记这一组失败"),
  });

  const finish = useMutation({
    mutationFn: () =>
      api.patch<{ summary: SessionDetail["summary"] }>(`/api/v1/sessions/${sessionId}`, {
        status: "done",
        ended_at: new Date().toISOString(),
        paused_sec: Math.round(local.pausedMs / 1000),
      }),
    onSuccess: async (res) => {
      setFinished(res.summary);
      window.localStorage.removeItem(`fitness-session-${sessionId}`);
      await queryClient.invalidateQueries({ queryKey: qk.today() });
      await queryClient.invalidateQueries({ queryKey: qk.history() });
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "结束失败"),
  });

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      try {
        audioRef.current = new AudioContext();
      } catch {
        audioRef.current = null;
      }
    }
  }, []);

  if (isLoading) return <div className="card mt-10 h-40 animate-pulse" />;
  if (!data) return <Empty>找不到这次训练</Empty>;

  if (finished || data.session.status === "done" || data.session.status === "aborted") {
    const summary = finished ?? data.summary;
    return (
      <main className="mt-6">
        <Card>
          <div className="text-lg font-bold">收工 ✓</div>
          <div className="muted mt-1 text-[12.5px]">
            今天算练完了 —— 打卡、循环推进、恢复度都会跟着更新
          </div>
          <Divider />
          <div className="grid grid-cols-2 gap-3 text-center">
            <SummaryCell label="总组数" value={`${summary?.totalSets ?? 0}`} />
            <SummaryCell
              label={`总容量（${unit}，按总重）`}
              value={volumeText(summary?.volumeKg, unit)}
            />
            <SummaryCell label="时长（分钟）" value={durationMinutesText(summary?.durationSec)} />
            <SummaryCell
              label="组间歇均值"
              value={summary?.avgRestSec ? `${summary.avgRestSec} 秒` : "—"}
              hint={summary?.avgChangeoverSec ? `换项 ${summary.avgChangeoverSec} 秒` : undefined}
            />
          </div>
          <div className="mt-4 space-y-2">
            <button className="btn btn-primary btn-block" onClick={() => router.push("/")}>
              回今日
            </button>
            <button
              className="btn btn-secondary btn-block"
              onClick={() => router.push(`/history/session/${sessionId}`)}
            >
              看这次详情
            </button>
          </div>
        </Card>
      </main>
    );
  }

  const draftKey = current ? String(current.exerciseId) : "";
  const draft = local.draft[draftKey] ?? {};
  // 器械变体（13.14 / FR-49）：默认变体 = 动作本身（id = null）
  const variantList = current?.variants ?? [];
  const activeVariant = variantList.find((v) => (v.id ?? null) === (draft.variantId ?? null)) ?? variantList[0] ?? null;
  const variantLabel = (v: NonNullable<typeof activeVariant>) => v.label || v.equip || "默认器械";
  const variantBadge = (semantics: string) =>
    semantics === "ratio_2to1" ? "2:1" : semantics === "assist" ? "助力" : semantics === "band" ? "弹力带" : null;
  const prefillForVariant =
    data.prefill?.[draftKey]?.[draft.variantId ? String(draft.variantId) : "default"] ?? null;
  /**
   * 当前动作的**生效读数单位**（v1.38 / issue #36）：变体上配了按它，没配跟随全局设置。
   * 只作用于"读数展示与录入"，**汇总（总容量 / 统计 / 趋势 / 导出）仍按全局设置**（13.1 展示层）。
   */
  const readUnit = effectiveReadUnit(activeVariant?.readUnit, unit);
  /** 当前输入对应的总重（13.1 的同一份折算，页面不另写一份）：拿不到 = 这组不计容量 */
  const draftTotalKg = current
    ? totalLoadKg({
        weightKg: draft.weight ?? null,
        loadMode: current.loadMode as LoadMode,
        barKg: current.barKg,
        semantics: activeVariant?.semantics ?? "direct",
      })
    : null;
  const switchVariant = (variantId: number | null) => {
    // 换器械 → 预填按新变体的历史重来：清掉这一屏的重量/次数草稿，不要把上一台的重量带过去（踩坑第 33 条）
    setLocal((prev) => ({
      ...prev,
      draft: { ...prev.draft, [draftKey]: { variantId } },
    }));
    setVariantSheet(false);
    const target = variantList.find((v) => (v.id ?? null) === variantId);
    toast.show(
      variantId === null
        ? "换回默认器械 · 预填按它的历史重来"
        : `换到「${target ? variantLabel(target) : "变体"}」· 预填按这台的历史重来`,
    );
  };

  return (
    <main>
      <div className="mb-2 flex items-center justify-between">
        <div className="muted text-[12.5px]">
          {data.session.part} · {data.session.mode === "home" ? "居家自重" : "健身房"}
        </div>
        <div className="text-[12.5px] font-semibold">
          {/* 全场进度（issue #37）：和"本动作第几组"分开说 —— 不再用 4/16 这种裸分数 */}
          {overallSetText(doneSets, totalTarget)}
          {warmupCount > 0 && <span className="muted ml-1 font-normal">· 热身 {warmupCount} 组不计</span>}
        </div>
      </div>

      {/* 倒计时态（issue #33 / v1.39）：只有倒计时 —— 大号数字 + 到点提示音/震动 + 跳过休息 + 下一组目标。
          记组卡在这一态里**整块不渲染**（一个时刻只有一个态）；数字由绝对时间戳反算，锁屏回来接着走。
          倒计时的唯一入口是【结束这组】且该组落库成功（FR-9 v1.50）。 */}
      {phase === "rest" && (
        <Card className="mb-3 text-center">
          <div className="muted text-[12px]">
            组间歇
            {current && (
              <span className="ml-1">
                ·
                {(local.restFor ?? {})[String(current.exerciseId)] !== undefined
                  ? " 本次临时"
                  : current.restSec
                    ? ` 这个动作默认 ${current.restSec}s`
                    : ` 本次默认 ${data.session.restTargetSec}s`}
              </span>
            )}
          </div>
          <div className="mt-1 text-[64px] leading-none font-bold tabular-nums">
            {paused || remainingSec > 0 ? clockText(remainingSec) : "0:00"}
          </div>
          {paused && <div className="muted mt-1 text-[12.5px]">已暂停 · 时间冻住了，继续就接着走</div>}
          {current && (
            <div className="mt-2 text-[13px]">
              下一组：<span className="font-semibold">{current.name}</span> · 目标 {current.targetReps}
              {current.type === "time" ? " 秒" : " 次"}
            </div>
          )}
          {/* 留白处一句话（词库：src/data/encouragements.json；相邻不重复，池空有兜底） */}
          {restLine && <div className="muted mt-2 text-[12.5px]">{restLine}</div>}

          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              className="btn btn-primary min-h-[44px] px-5 text-[14px]"
              onClick={() => setLocal((prev) => ({ ...prev, ...stopRest(), pausedMs: 0, pauseStart: null }))}
            >
              跳过休息（去记下一组）
            </button>
            {/* 暂停是 FR-42 的契约，降级为次级按钮但**不删**：它只冻住倒计时，不是"重启" */}
            <button
              type="button"
              className="tap rounded-xl border border-border px-3 text-[12.5px]"
              onClick={() =>
                setLocal((prev) =>
                  prev.pauseStart === null
                    ? { ...prev, ...pauseRest({ restEnd: prev.restEnd, restRemainMs: prev.restRemainMs }, Date.now()), pauseStart: Date.now() }
                    : {
                        ...prev,
                        ...resumeRest({ restEnd: prev.restEnd, restRemainMs: prev.restRemainMs }, Date.now()),
                        pausedMs: prev.pausedMs + (Date.now() - (prev.pauseStart ?? Date.now())),
                        pauseStart: null,
                      },
                )
              }
            >
              {paused ? "继续" : "暂停"}
            </button>
          </div>
          <div className="muted mt-2 text-[11.5px]">
            倒计时不给重来 —— 档位改动只影响下一次；跳过就是终止，不是从头再数
          </div>

          {/* 档位单独一行：手机上不至于挤成一团（本次临时档按动作记，FR-52） */}
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
            {[
              ...[60, 90, 120, current?.restSec ?? null, data.session.restTargetSec].filter(
                (v): v is number => typeof v === "number" && v > 0,
              ),
            ]
              .filter((sec, index, arr) => arr.indexOf(sec) === index)
              .sort((a, b) => a - b)
              .map((sec) => (
                <button
                  key={sec}
                  type="button"
                  className={`tap rounded-lg px-3 text-[12.5px] ${
                    current && restSecFor(current) === sec ? "bg-accent text-accent-fg" : "border border-border"
                  }`}
                  onClick={() =>
                    current &&
                    setLocal((prev) => ({
                      ...prev,
                      restFor: { ...(prev.restFor ?? {}), [String(current.exerciseId)]: sec },
                    }))
                  }
                >
                  {sec}s
                </button>
              ))}
          </div>
        </Card>
      )}

      {/* 今日动作总览：一眼看到练到哪、还剩哪几个；右边的「编辑」进 FR-10 的本次清单编辑 */}
      <div className="mb-3 flex items-center gap-2">
        {exercises.length > 1 && (
          <div className="flex flex-1 gap-1.5 overflow-x-auto pb-1">
            {exercises.map((ex) => {
              const n = Math.min(progress.get(ex.exerciseId) ?? 0, ex.targetSets);
              const isCurrent = current?.exerciseId === ex.exerciseId;
              const complete = n >= ex.targetSets;
              return (
                <div
                  key={ex.id}
                  className={`shrink-0 rounded-xl border px-2.5 py-1.5 text-[12px] ${
                    isCurrent ? "border-accent bg-accent-soft font-semibold" : "border-border"
                  } ${complete && !isCurrent ? "muted" : ""}`}
                >
                  {/* 只留视觉态（✓ / 高亮当前），不再重复输出 n/M 组 —— 那个数在记组卡上说（issue #37） */}
                  {complete ? "✓ " : ""}
                  {ex.name}
                </div>
              );
            })}
          </div>
        )}
        {exercises.length === 1 && <div className="flex-1" />}
        <button
          type="button"
          className="tap shrink-0 rounded-lg border border-border px-2.5 text-[12px]"
          onClick={() => setEditorOpen(true)}
        >
          编辑本次清单
        </button>
      </div>

      {/* 收工态（issue #39 / v1.40）：动作都做满了（或他点过「再练一组」）—— 小结 + 大按钮，不自动收工 */}
      {inFinish && (
        <Card>
          <div className="text-lg font-bold">都做完了 ✓</div>
          <div className="muted mt-1 text-[12.5px]">
            这一场的结果在下面；点大按钮才算收工（收工会自动打卡、推进循环）
          </div>
          <Divider />
          <div className="grid grid-cols-2 gap-3 text-center">
            <SummaryCell label="总组数" value={`${(finished ?? data.summary)?.totalSets ?? doneSets}`} />
            <SummaryCell
              label={`总容量（${unit}，按总重）`}
              value={volumeText((finished ?? data.summary)?.volumeKg, unit)}
            />
            <SummaryCell label="训练时长（分钟）" value={durationMinutesText((finished ?? data.summary)?.durationSec)} />
            <SummaryCell
              label="组间歇均值"
              value={(finished ?? data.summary)?.avgRestSec ? `${(finished ?? data.summary)?.avgRestSec} 秒` : "—"}
              hint={
                (finished ?? data.summary)?.avgChangeoverSec
                  ? `换项 ${(finished ?? data.summary)?.avgChangeoverSec} 秒`
                  : undefined
              }
            />
          </div>
          <button
            className="btn btn-primary btn-block mt-4 min-h-[58px] text-[17px]"
            disabled={finish.isPending}
            onClick={() => finish.mutate()}
          >
            {finish.isPending ? "收工中…" : "收工，今天算练完了"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-block mt-2 min-h-[44px] text-[13.5px]"
            onClick={() => {
              setExtraSetMode(true);
            }}
          >
            再练一组
          </button>
          <div className="muted mt-2 text-center text-[11.5px]">
            不点什么都不发生；「再练一组」只是回到记组卡，不会替你收工
          </div>
        </Card>
      )}

      {/* 记组态（issue #33）：一个时刻只有一个态 —— 倒计时或收工态里这块整卡不渲染 */}
      {phase === "rest" || inFinish ? null : current ? (
        <Card>
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <div className="text-[17px] font-bold">{current.name}</div>
              <div className="muted text-[12px]">
                {/* 「第 X 组」全站只在这里出现一次；做满之后不再说"第几组"（issue #37） */}
                {exerciseSetText(currentDoneSets, current.targetSets, { extraSet: extraSetMode })} · 目标{" "}
                {current.targetReps}
                {current.type === "time" ? " 秒" : " 次"}
              </div>
              {/* 器械变体（13.14）：有多个变体时点胶囊就换，预填按新变体的历史重来 */}
              {variantList.length > 1 && activeVariant && (
                <button
                  type="button"
                  className="tap mt-1.5 gap-1.5 rounded-lg border border-border px-2 text-[12px]"
                  onClick={() => setVariantSheet(true)}
                  aria-label="换器械变体"
                >
                  <span className="font-medium">{variantLabel(activeVariant)}</span>
                  {variantBadge(activeVariant.semantics) && (
                    <span className="muted text-[11px]">{variantBadge(activeVariant.semantics)}</span>
                  )}
                  <span className="muted text-[11px]">▾ 换器械</span>
                </button>
              )}
            </div>
          </div>

          <Divider />

          {/* 进行中态（FR-9 v1.50 / issue #75）：大号本组计时 + 一句"什么时候才开始算休息"；
              计时按**开始那一刻的绝对时间戳**反算 —— 锁屏 / 切 App 回来接着走，不重置、不归零。 */}
          {phase === "doing" && (
            <div className="text-center">
              <div className="muted text-[12px]">这一组在进行中（锁屏它也在走）</div>
              <div className="mt-1 text-[56px] leading-none font-bold tabular-nums">{clockText(doingSec)}</div>
              <div className="muted mt-1.5 text-[11.5px]">
                做完点下面【结束这组】—— 那一刻才开始算组间歇
              </div>
            </div>
          )}

          {/* 重量（issue #35）：降为次要区 —— 默认折叠成一行摘要，点开才展开加减器与总重。
              不填 = null（不沿用上次、不猜、不补 0）；空的读数不计容量，也绝不当 0 算（13.1）。 */}
          {current.type === "weight" && (
            <div className="space-y-2">
              {weightOpen ? (
                <div className="space-y-2">
                  <StepperRow
                    label={weightLabel(current.loadMode as LoadMode, activeVariant?.semantics, readUnit)}
                    testId="stepper-weight"
                    value={kgToDisplay(draft.weight ?? 0, readUnit) ?? 0}
                    step={weightStep(readUnit)}
                    max={weightMax(readUnit)}
                    onChange={(v) =>
                      setLocal((prev) => ({
                        ...prev,
                        // 草稿与入库一律 kg：这里把展示值换算回去（§1.1）
                        draft: { ...prev.draft, [draftKey]: { ...draft, weight: displayToKg(v, readUnit) ?? 0 } },
                      }))
                    }
                  />
                  {/* 这组总重（13.1 的折算，实时跟着输入变）：库内仍是"单侧读数 + 折算总重" */}
                  <div className="muted text-[11.5px]">
                    {draftTotalKg !== null
                      ? `这组总重 ≈ ${formatWeight(draftTotalKg, readUnit)}`
                      : "这组不计容量（没填读数 / 助力 / 弹力带）"}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="tap-ghost text-left text-[13px]"
                  onClick={() => setWeightOpen(true)}
                >
                  重量 <span className="font-semibold">{weightSummaryText(draft.weight, readUnit)}</span>
                  <span className="muted ml-1.5 text-[11.5px]">改重量 ▾</span>
                </button>
              )}
              {/* 「照上次填」改成可选沿用（FR-7 v1.37）：不预填进输入框，点一下才写入 */}
              {prefillForVariant?.weightKg ? (
                <div className="muted text-[11.5px]">
                  上次 {formatWeight(prefillForVariant.weightKg, readUnit)}
                  {draft.weight === undefined && (
                    <button
                      type="button"
                      className="tap-ghost ml-1 text-accent"
                      onClick={() => {
                        setWeightOpen(true);
                        setLocal((prev) => ({
                          ...prev,
                          draft: { ...prev.draft, [draftKey]: { ...draft, weight: prefillForVariant.weightKg ?? undefined } },
                        }));
                      }}
                    >
                      点一下沿用
                    </button>
                  )}
                  {activeVariant ? `（同器械变体：${variantLabel(activeVariant)}）` : ""}
                </div>
              ) : (
                <div className="muted text-[11.5px]">这台还没记录过 · 想记就点开填，不填也能过</div>
              )}
            </div>
          )}

          <StepperRow
            label={current.type === "time" ? "秒数" : "次数"}
            testId="stepper-reps"
            value={
              current.type === "time"
                ? (draft.duration ?? prefillForVariant?.durationSec ?? current.targetReps)
                : (draft.reps ?? prefillForVariant?.reps ?? current.targetReps)
            }
            step={1}
            max={REPS_RANGE.max}
            onChange={(v) =>
              setLocal((prev) => ({
                ...prev,
                draft: { ...prev.draft, [draftKey]: { ...draft, [current.type === "time" ? "duration" : "reps"]: v } },
              }))
            }
          />

          {/* 练前热身提示（FR-53 v1.26：热身不记录）：只在还没记下第一组时露一次，练起来就消失
              —— 计划的「N 组」一律指正式组，热身不占其中（用户 2026-10-09 明确） */}
          {sets.length === 0 && (
            <p className="muted mt-3 text-[11.5px]">
              先热身：1–2 组轻重量，不算在计划的组数里 —— 从正式组开始记
            </p>
          )}

          {/* 每组感受（FR-11）：可标可不标；再点一下取消。标了会跟着这一组一起存，历史里可见 */}
          <div className="mt-3">
            <div className="muted text-[11.5px]">这组感受（可以不标）</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {FEEL_OPTIONS.map((f) => {
                const active = draft.feel === f.value;
                return (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={active}
                    className={`tap rounded-lg border px-2.5 text-[12.5px] ${
                      active ? "border-accent bg-accent-soft font-semibold" : "border-border"
                    }`}
                    onClick={() =>
                      setLocal((prev) => ({
                        ...prev,
                        draft: {
                          ...prev.draft,
                          [draftKey]: { ...draft, feel: active ? null : f.value },
                        },
                      }))
                    }
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>

      {/* 主按钮（FR-9 v1.50 / issue #75）：待开始 → 【开始这组】（**不起倒计时**）；
          进行中 → 【结束这组】（落库成功才进倒计时，最后一组例外：直接收工态，issue #77） */}
      <button
        className="btn btn-primary btn-block mt-4 min-h-[58px] text-[17px]"
        disabled={
          completeSet.isPending ||
          justRecorded ||
          (phase === "record" && currentDone && !extraSetMode)
        }
        onClick={() => {
          ensureAudio();
          if (phase === "doing") {
            completeSet.mutate({ exercise: current });
            return;
          }
          // 开始这组：记下绝对开始时刻；顺手把 `now` 推进一格 —— 否则这一帧的
          // `now`（250ms 心跳的旧值）还早于开始时刻，卡片会闪回"待开始"
          const startedAt = Date.now();
          setNow(startedAt);
          setLocal((prev) => ({
            ...prev,
            setStartedAt: startedAt,
            restEnd: null,
            restRemainMs: null,
          }));
        }}
      >
        {setButtonLabel({
          phase: phase === "doing" ? "doing" : "record",
          exerciseDone: currentDone && !extraSetMode,
          pending: completeSet.isPending,
          justRecorded,
        })}
      </button>

          <div className="muted mt-2 text-center text-[11.5px]">
            {draft.feel
              ? `这组会记「${FEEL_OPTIONS.find((f) => f.value === draft.feel)?.label}」· 训练中不校验，也可以不标`
              : "感受可以不标 · 训练中不校验，留空也能过"}
          </div>
        </Card>
      ) : (
        <Empty>
          没有待做的动作了
          {emptyLine && <div className="muted mt-1 text-[12.5px] font-normal">{emptyLine}</div>}
        </Empty>
      )}

      {/* 未做满时的「提前结束」照旧（第 12 章第 15 条，二次确认保留）；收工态里由卡内大按钮接管 */}
      <div className={inFinish ? "hidden" : "mt-3"}>
        <button
          className="btn btn-secondary btn-block"
          onClick={async () => {
            // 【提前结束】必须算练完（第 12 章第 15 条）：只练了 3 个动作也是练了
            if (doneSets >= totalTarget || (await confirmDialog({ title: "提前结束也算练完，确定收工？" }))) {
              finish.mutate();
            }
          }}
        >
          {doneSets >= totalTarget ? "收工，今天算练完了" : "提前结束（一样算练完）"}
        </button>
      </div>

      {/* FR-10 的 doing 阶段：本次清单编辑（只影响本次会话，模板不动） */}
      <Sheet open={editorOpen} title="编辑本次清单（只影响这次）" onClose={() => setEditorOpen(false)}>
        <p className="muted text-[12px] leading-relaxed">
          器械被占就先做别的：点「先做这个」把它提到当前；「换一个」只换位置上的动作、目标组数次数保留。
          已经记过组的动作，移出或换掉前会先问一句（那几组会一起丢掉）。
        </p>
        <div className="mt-3 space-y-2">
          {exercises.map((ex, index) => {
            const n = Math.min(progress.get(ex.exerciseId) ?? 0, ex.targetSets);
            const isCurrent = current?.id === ex.id;
            return (
              <div key={ex.id} className="rounded-xl border border-border px-2.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">
                      {isCurrent ? "▶ " : ""}
                      {ex.name}
                    </div>
                    <div className="muted text-[11.5px]">
                      {n}/{ex.targetSets} 组 · 目标 {ex.targetReps}
                      {ex.type === "time" ? " 秒" : " 次"}
                      {n > 0 ? ` · 已记 ${n} 组` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`把 ${ex.name} 往上挪`}
                      className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                      onClick={() => editExercises.mutate({ kind: "move", id: ex.id, move: "up" })}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`把 ${ex.name} 往下挪`}
                      className="grid h-8 w-8 place-items-center rounded-lg border border-border"
                      onClick={() => editExercises.mutate({ kind: "move", id: ex.id, move: "down" })}
                    >
                      ▼
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2 text-[12px]"
                    disabled={isCurrent}
                    onClick={() => {
                      editExercises.mutate({ kind: "move", id: ex.id, move: "first" });
                      setEditorOpen(false);
                      toast.show(`先做「${ex.name}」`);
                    }}
                  >
                    先做这个
                  </button>
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2 text-[12px]"
                    onClick={() => {
                      setReplaceTarget({ id: ex.id, name: ex.name });
                      setPickerOpen(true);
                    }}
                  >
                    换一个
                  </button>
                  <span className="flex items-center gap-1 text-[12px]">
                    <span className="muted">本次</span>
                    <Stepper
                      label="组"
                      value={ex.targetSets}
                      onChange={(v) => editExercises.mutate({ kind: "targets", id: ex.id, sets: v })}
                    />
                    <Stepper
                      label={ex.type === "time" ? "秒" : "次"}
                      value={ex.targetReps}
                      onChange={(v) => editExercises.mutate({ kind: "targets", id: ex.id, reps: v })}
                    />
                  </span>
                  <button
                    type="button"
                    className="tap ml-auto rounded-lg border border-border px-2 text-[12px] text-alert"
                    disabled={exercises.length <= 1}
                    onClick={() => void removeExercise(ex)}
                  >
                    移出今天
                  </button>
                </div>
                <div className="muted mt-1 text-[11px]">
                  第 {index + 1} 个 · 目标组数不能低于已记的 {n} 组
                </div>
              </div>
            );
          })}
        </div>
        <button
          className="btn btn-secondary btn-block mt-3 min-h-[44px] text-[13.5px]"
          onClick={() => {
            setReplaceTarget(null);
            setPickerOpen(true);
          }}
        >
          + 从动作库加动作
        </button>
        <button className="btn btn-primary btn-block mt-2 min-h-[44px] text-[13.5px]" onClick={() => setEditorOpen(false)}>
          改完了，继续练
        </button>
      </Sheet>

      <Sheet
        open={pickerOpen}
        title={replaceTarget ? `换掉「${replaceTarget.name}」` : "从动作库加动作"}
        onClose={() => {
          setPickerOpen(false);
          setReplaceTarget(null);
        }}
      >
        <ExercisePicker
          open={pickerOpen}
          title=""
          exercises={lib?.exercises ?? []}
          muscles={lib?.taxonomy.muscles ?? []}
          prefer={current ? current.muscles : []}
          excludeIds={exercises.map((e) => e.exerciseId)}
          onClose={() => {
            setPickerOpen(false);
            setReplaceTarget(null);
          }}
          onPick={(picked) => {
            if (replaceTarget) {
              void swapExercise(replaceTarget, picked.id);
            } else {
              editExercises.mutate({
                kind: "add",
                exerciseId: picked.id,
                sets: picked.sets,
                reps: picked.reps,
              });
              toast.show(`加了「${picked.name}」· 只影响这次`);
            }
            setPickerOpen(false);
            setReplaceTarget(null);
          }}
        />
      </Sheet>

      {variantList.length > 1 && (
        <Sheet open={variantSheet} title="换器械变体（读数各算各的）" onClose={() => setVariantSheet(false)}>
          <p className="muted text-[12px] leading-relaxed">
            同一动作换台器械，读数不是一个物理量：预填、常用重量、PR、趋势、历史分组都按「动作 × 变体」分开算
            （13.14）。助力 / 弹力带不计容量，滑轮 2:1 按 ×2 折算。
          </p>
          <div className="mt-3 space-y-1.5">
            {(current?.variants ?? []).map((v) => {
              const active = (v.id ?? null) === (draft.variantId ?? null);
              const last = data.prefill?.[draftKey]?.[v.id === null ? "default" : String(v.id)] ?? null;
              return (
                <button
                  key={v.id ?? "default"}
                  type="button"
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left ${
                    active ? "border-accent bg-accent-soft" : "border-border"
                  }`}
                  onClick={() => switchVariant(v.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">
                      {variantLabel(v)}
                      {v.id === null && <span className="muted ml-1.5 text-[11px]">动作库默认</span>}
                    </span>
                    <span className="muted block truncate text-[11.5px]">
                      {last?.weightKg
                        ? `上次 ${formatWeight(last.weightKg, effectiveReadUnit(v.readUnit, unit))} · ${weightReadHint(current?.loadMode as LoadMode, v.semantics)}`
                        : last?.reps
                          ? `上次 ${last.reps} 次`
                          : "这台还没记录过"}
                      {variantBadge(v.semantics) ? ` · ${variantBadge(v.semantics)}` : ""}
                      {v.baseWeight !== null
                        ? ` · 参考 ${formatWeight(v.baseWeight, effectiveReadUnit(v.readUnit, unit))}`
                        : ""}
                      {v.readUnit ? ` · 按 ${v.readUnit} 读` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12.5px] text-accent">{active ? "在用" : "用这台"}</span>
                </button>
              );
            })}
          </div>
          <p className="muted mt-3 text-[11.5px]">
            变体维护（增删改、读数语义）在
            <a className="tap-ghost ml-1 inline-block leading-5 text-accent underline underline-offset-2" href="/settings/exercises">
              我的 → 动作库
            </a>
            。
          </p>
        </Sheet>
      )}
    </main>
  );
}

function SummaryCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <div className="text-lg font-bold">{value}</div>
      <div className="muted text-[11px]">{label}</div>
      {hint && <div className="muted text-[10.5px]">{hint}</div>}
    </div>
  );
}

function StepperRow({
  label,
  value,
  step,
  max = REPS_RANGE.max,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  /** 步进上限（重量 400 / 次数 999）：默认值也取同一份范围常量（issue #28） */
  max?: number;
  testId?: string;
  onChange: (v: number) => void;
}) {
  // 长按连续步进（§1.5）：按住约 400ms 后自动重复、每 95ms 一挡；松手产生的 click 被抑制
  const holdTimer = useRef<number | null>(null);
  const repeatTimer = useRef<number | null>(null);
  const longPressRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const bump = (dir: 1 | -1) => {
    const next = Math.min(max, Math.max(0, Math.round((valueRef.current + dir * step) * 10) / 10));
    valueRef.current = next;
    onChange(next);
  };
  const stopRepeat = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (repeatTimer.current !== null) {
      window.clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  const arrowButton = (dir: 1 | -1, glyph: string, ariaLabel: string) => (
    <button
      type="button"
      className="grid h-11 w-11 place-items-center rounded-xl border border-border text-xl"
      aria-label={ariaLabel}
      onPointerDown={() => {
        longPressRef.current = false;
        stopRepeat();
        holdTimer.current = window.setTimeout(() => {
          longPressRef.current = true;
          repeatTimer.current = window.setInterval(() => bump(dir), 95);
        }, 400);
      }}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onBlur={stopRepeat}
      onClick={() => {
        if (longPressRef.current) {
          longPressRef.current = false;
          return;
        }
        bump(dir);
      }}
    >
      {glyph}
    </button>
  );

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px]">{label}</span>
      <div className="flex items-center gap-2">
        {arrowButton(-1, "−", `减少${label}`)}
        <span className="w-16 text-center text-xl font-bold" data-testid={testId}>{value}</span>
        {arrowButton(1, "+", `增加${label}`)}
      </div>
    </div>
  );
}
