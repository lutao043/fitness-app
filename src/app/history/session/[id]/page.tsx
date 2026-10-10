"use client";

/**
 * 单次训练详情（FR-13）：按动作分组的组明细，可改重量、可删记错的组，实时重算小结。
 * 组间歇与换项间隔分列（13.5）—— 跨动作的间隔天然更久，不混进"组间歇均值"。
 *
 * v1.18 补明细：这里可以直接「+ 加一个动作」「+ 加一组」（补录的组不记组间歇），
 * 已收工的会话也允许 —— 打卡日 / 漏记的日子事后补明细是合法操作（13.4 / FR-13）。
 */

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qk, type ExerciseLibraryRow, type SessionDetail } from "@/client/api";
import { ExercisePicker } from "@/components/exercise-picker";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { Card, Divider, Empty, Pill, Sheet } from "@/components/ui";
import { formatCn } from "@/lib/time";
import { durationMinutesText, totalLoadKg } from "@/lib/caliber";
import { semanticsForEquip, type LoadMode } from "@/lib/exercise/types";
import { displayToKg, formatWeight, kgToDisplay, volumeText } from "@/lib/units";

/** 本动作这一场的容量（kg，按总重；不计容量的组算 0）—— 与小结同口径，只是换了展示位置（issue #45） */
function groupVolumeKg(sets: SessionDetail["sets"]): number {
  return Math.round(sets.reduce((sum, s) => sum + (s.totalLoadKg ?? 0) * (s.reps ?? 0), 0));
}

/** 每组感受（FR-11）：存的是枚举，界面出中文；吃力 / 力竭给重色（原型同款） */
const FEEL_LABEL: Record<string, string> = { easy: "轻松", normal: "正常", hard: "吃力", failure: "力竭" };

type PrefillMap = Record<string, Record<string, { weightKg: number | null; reps: number | null; durationSec: number | null }>>;

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const sessionId = Number(params.id);
  const router = useRouter();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  /** 「换动作」（issue #43）：记录页把某动作本次已记的组整体搬到另一个动作 */
  const [moveFrom, setMoveFrom] = useState<{ exerciseId: number; name: string } | null>(null);
  /** 组行的「…」菜单（issue #45）：一次只开一行 */
  const [menuFor, setMenuFor] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: qk.session(sessionId),
    queryFn: () => api.get<SessionDetail & { prefill: PrefillMap }>(`/api/v1/sessions/${sessionId}`),
  });

  // 动作库只在打开「加动作」时取（91 条不必随详情页加载）
  const { data: lib } = useQuery({
    queryKey: qk.exercises(),
    queryFn: () => api.get<{ exercises: ExerciseLibraryRow[]; taxonomy: { muscles: string[] } }>("/api/v1/exercises"),
    enabled: addOpen,
  });

  /**
   * 换动作（issue #43）：先让他在动作库里挑一个 → 确认弹窗里说清"搬几组、容量怎么变" → 才提交。
   * 容量按**新动作**的口径实时试算（与服务端同一份折算：`totalLoadKg`，页面不另写一份）。
   */
  const moveSets = useMutation({
    mutationFn: (args: { fromExerciseId: number; toExerciseId: number }) =>
      api.post<{ changed: boolean; movedSets: number; volumeBeforeKg: number; volumeAfterKg: number }>(
        `/api/v1/sessions/${sessionId}/exercises/move`,
        { from_exercise_id: args.fromExerciseId, to_exercise_id: args.toExerciseId },
      ),
    onSuccess: async (res) => {
      await refresh();
      toast.show(
        res.changed ? `换了动作 · 搬走 ${res.movedSets} 组（容量 ${res.volumeBeforeKg} → ${res.volumeAfterKg} kg）` : "换的是同一个动作，没动",
      );
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "换动作失败"),
  });

  /**
   * 换动作（issue #43）：先在动作库里挑「换成哪个」→ 确认弹窗说清"搬几组、容量怎么变" → 才提交。
   * 容量按**新动作**的口径实时试算（与服务端同一份折算：`totalLoadKg`，页面不另写一份）。
   */
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
    await queryClient.invalidateQueries({ queryKey: qk.history() });
    await queryClient.invalidateQueries({ queryKey: qk.today() });
  };

  const groups = useMemo(() => {
    const map = new Map<number, SessionDetail["sets"]>();
    for (const set of data?.sets ?? []) {
      const list = map.get(set.exerciseId) ?? [];
      list.push(set);
      map.set(set.exerciseId, list);
    }
    return Array.from(map.entries());
  }, [data?.sets]);

  const removeSet = useMutation({
    mutationFn: (setId: number) => api.del(`/api/v1/sessions/${sessionId}/sets/${setId}`),
    onSuccess: async () => {
      await refresh();
      toast.show("已删掉这一组");
    },
  });

  const saveSet = useMutation({
    mutationFn: (args: { setId: number; weightKg: number }) =>
      api.patch(`/api/v1/sessions/${sessionId}/sets/${args.setId}`, { weight_kg: args.weightKg }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
      toast.show("已保存并重算容量");
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "保存失败"),
  });

  /**
   * 补一组（FR-13 v1.18）：按这个动作**本次**最后一组的读数预填（没有就用全局「上次」），
   * `backfill: true` 让服务端不记组间歇 —— 补录时刻与上一组差几小时，算出来的是假数（13.5）。
   */
  const addSet = useMutation({
    mutationFn: (args: { exerciseId: number }) => {
      if (!data) throw new Error("还没读到这次训练");
      const groupSets = data.sets.filter((s) => s.exerciseId === args.exerciseId);
      const last = groupSets.at(-1) ?? null;
      const target = data.exercises.find((e) => e.exerciseId === args.exerciseId) ?? null;
      const prefill =
        data.prefill?.[String(args.exerciseId)]?.[last?.variantId ? String(last.variantId) : "default"] ?? null;
      const isTime = target?.type === "time";
      const setNo = groupSets.length + 1;
      return api.post(`/api/v1/sessions/${sessionId}/sets`, {
        client_key: `${data.session.clientId}:bf:${args.exerciseId}:${setNo}:${Date.now()}`,
        exercise_id: args.exerciseId,
        set_no: setNo,
        variant_id: last?.variantId ?? null,
        weight_kg: last?.weightKg ?? prefill?.weightKg ?? target?.baseWeight ?? null,
        reps: isTime ? null : (last?.reps ?? prefill?.reps ?? target?.targetReps ?? null),
        duration_sec: isTime ? (last?.durationSec ?? prefill?.durationSec ?? target?.targetReps ?? null) : null,
        done_at: new Date().toISOString(),
        backfill: true,
      });
    },
    onSuccess: async (_res, args) => {
      await refresh();
      const name = data?.exercises.find((e) => e.exerciseId === args.exerciseId)?.name ?? "这个动作";
      toast.show(`给「${name}」补了一组 · 不记组间歇`);
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没补上，再试一次"),
  });

  /** 补一个动作（FR-13 v1.18）：已收工的会话也能加；加完回到这一页就能给它补组 */
  const addExercise = useMutation({
    mutationFn: (args: { exerciseId: number; name: string; sets: number; reps: number }) =>
      api.post(`/api/v1/sessions/${sessionId}/exercises`, {
        exercise_id: args.exerciseId,
        target_sets: args.sets,
        target_reps: args.reps,
      }),
    onSuccess: async (_res, args) => {
      await refresh();
      toast.show(`加了「${args.name}」· 下面点「+ 加一组」补明细`);
    },
    onError: (err) => toast.show(err instanceof Error ? err.message : "没加上，再试一次"),
  });

  if (isLoading) return <div className="card mt-10 h-40 animate-pulse" />;
  if (!data) return <Empty>找不到这次训练</Empty>;

  const s = data.summary;
  /** 展示单位（§1.1）：库里一律 kg，编辑重量时换算回去再提交 */
  const unit = data.unit ?? "kg";

  return (
    <main>
      <button className="tap-ghost mb-2 text-[13px] text-accent" onClick={() => router.push("/history")}>
        ← 返回
      </button>

      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-bold">{data.session.part || "训练"}</div>
            <div className="muted text-[12.5px]">
              {formatCn(data.session.date)} · {data.session.mode === "home" ? "居家自重" : "健身房"}
            </div>
          </div>
          <Pill tone={data.session.status === "done" ? "ok" : "plain"}>
            {data.session.status === "done" ? "已练完" : data.session.status === "aborted" ? "已中断" : "进行中"}
          </Pill>
        </div>
        <Divider />
        {/* 小结（issue #45 改版）：主位是**完成度**（组数比 + 动作做满）——
            总容量那种"越练越唬人、还缺自重/助力/弹力带一块"的合计数不该占主位，已下放到各动作分组里的一行小字。 */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Cell
            label="完成度"
            value={data.completion?.setsText ?? "—"}
            hint={data.completion?.exercisesText}
          />
          <Cell label="总组数" value={`${s.totalSets}`} />
          <Cell label="时长" value={durationMinutesText(s.durationSec)} />
        </div>
        {/* 补明细（FR-13 v1.18）：打卡日 / 漏记的日子，直接在这里把动作和组补上 */}
        {data.session.status !== "aborted" && (
          <>
            <Divider />
            <button
              type="button"
              className="btn btn-secondary btn-block min-h-[40px] text-[13px]"
              onClick={() => setAddOpen(true)}
            >
              + 加一个动作（补明细）
            </button>
            <p className="muted mt-1.5 text-[11.5px]">
              补录的组<span className="font-semibold">不记组间歇</span>（没有真实间隔）；补完标题上的组数 / 容量立刻重算。
            </p>
          </>
        )}
      </Card>

      <div className="mt-3 space-y-3">
        {groups.map(([exerciseId, sets]) => {
          // 组数 = 正式组（13.16）：老记录里标过热身的行不计入组数，只在旁边注明（v1.26 起不再记录热身组）
          const warmupCount = sets.filter((s) => s.isWarmup).length;
          return (
          <Card key={exerciseId}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[15px] font-semibold">{sets[0]?.exerciseName}</div>
                <div className="muted text-[11.5px]">
                  {sets.length - warmupCount} 组
                  {/* 容量下放（issue #45）：本动作这一场的容量放这儿才有参照系 —— 全场合计没有心理标尺 */}
                  {groupVolumeKg(sets) > 0 ? ` · ${volumeText(groupVolumeKg(sets), unit)} ${unit}（按总重）` : ""}
                  {warmupCount > 0 ? ` · 热身 ${warmupCount} 组不计` : ""}
                  {sets[0]?.variantLabel || sets[0]?.variantCode ? ` · ${sets[0].variantLabel ?? sets[0].variantCode}` : ""}
                </div>
              </div>
              {data.session.status !== "aborted" && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* 换动作（issue #43）：记错动作时整体搬走，组间歇一起带走（删了重补会变成"补录"、丢掉组间歇） */}
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
                    onClick={() => setMoveFrom({ exerciseId, name: sets[0]?.exerciseName ?? "这个动作" })}
                  >
                    换动作
                  </button>
                  <button
                    type="button"
                    className="tap rounded-lg border border-border px-2.5 text-[12.5px]"
                    disabled={addSet.isPending}
                    onClick={() => addSet.mutate({ exerciseId })}
                  >
                    + 加一组
                  </button>
                </div>
              )}
            </div>
            <Divider />
            <div className="space-y-4">
              {sets.map((set) => (
                <div key={set.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="muted w-12">第{set.setNo}组</span>
                    {editing === set.id ? (
                      <span className="flex items-center gap-1">
                        <input
                          className="input h-9 w-20 py-1 text-[13px]"
                          value={editValue}
                          inputMode="decimal"
                          onChange={(e) => setEditValue(e.target.value)}
                        />
                        <span className="muted text-[11.5px]">{unit}</span>
                        <button
                          className="text-accent"
                          onClick={() =>
                            // 界面按展示单位输入，入库一律 kg（§1.1）
                            saveSet.mutate({
                              setId: set.id,
                              weightKg: displayToKg(Number(editValue), unit) ?? 0,
                            })
                          }
                        >
                          存
                        </button>
                      </span>
                    ) : (
                      <span>
                        {set.isWarmup ? (
                          <span className="muted mr-1 rounded-full bg-bg px-1.5 py-[1px] text-[10.5px]">热身</span>
                        ) : null}
                        {set.weightKg !== null && set.weightKg !== undefined ? formatWeight(set.weightKg, unit) : ""}
                        {set.reps ? ` × ${set.reps}` : ""}
                        {set.durationSec ? `${set.durationSec} 秒` : ""}
                        {set.totalLoadKg === null && set.weightKg ? (
                          <span className="muted ml-1 text-[11px]">（不计容量）</span>
                        ) : null}
                        {set.feel ? <FeelTag feel={set.feel} /> : null}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-6">
                    {set.restBeforeSec !== null && (
                      <span className="muted text-[11px]">
                        {set.sameExercise ? `组间歇 ${set.restBeforeSec}s` : `换项 ${set.restBeforeSec}s`}
                      </span>
                    )}
                    {/* 改 / 删收进一个「…」（issue #45：每行两个链接太吵），展开后行为与原来完全一致 */}
                    {menuFor === set.id ? (
                      <>
                        <button
                          className="tap-ghost text-[12px] text-accent underline underline-offset-2"
                          onClick={() => {
                            setEditing(set.id);
                            setEditValue(String(kgToDisplay(set.weightKg, unit) ?? ""));
                            setMenuFor(null);
                          }}
                        >
                          改
                        </button>
                        <button
                          className="tap-ghost text-[12px] text-alert underline underline-offset-2"
                          onClick={() => {
                            setMenuFor(null);
                            void confirmDialog({ title: "删掉这一组？", danger: true }).then((ok) => {
                              if (ok) removeSet.mutate(set.id);
                            });
                          }}
                        >
                          删
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`第${set.setNo}组的更多操作`}
                        className="tap grid h-8 w-8 place-items-center rounded-lg border border-border"
                        onClick={() => setMenuFor(set.id)}
                      >
                        …
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          );
        })}
        {groups.length === 0 && (
          <Empty>
            这次没有组明细（可能是一条「已打卡 · 无明细」）
            {data.session.status !== "aborted" && (
              <button
                type="button"
                className="btn btn-secondary btn-block mt-3"
                onClick={() => setAddOpen(true)}
              >
                + 加一个动作（补明细）
              </button>
            )}
          </Empty>
        )}
      </div>

      <p className="muted mt-4 text-center text-[11.5px]">
        {/* 组间歇从主位撤下来（issue #45）：它与"换项间隔"本来就该并排看 */}
        {s.avgRestSec ? `组间歇均值 ${s.avgRestSec} 秒` : "组间歇均值 —"}
        {s.avgChangeoverSec ? ` · 换项间隔 ${s.avgChangeoverSec} 秒` : ""}
      </p>
      <p className="muted mt-1 text-center text-[11.5px]">补录的组不记组间歇 · 助力与弹力带不计容量</p>

      {/* 补一个动作（FR-13 v1.18）：选好加进本次清单，回到列表点「+ 加一组」补明细 */}
      {/* 换动作 · 第一步：从动作库挑「换成哪个」 */}
      <Sheet
        open={moveFrom !== null}
        title={moveFrom ? `把「${moveFrom.name}」这次记的组换成…` : "换动作"}
        onClose={() => setMoveFrom(null)}
      >
        <p className="muted mb-2 text-[12px] leading-relaxed">
          整组搬过去：组数、次数、重量、感受、组间歇都原样保留（这条不是「删了重补」—— 补录的组不记组间歇）。
          容量会按新动作的口径重算，确认前会告诉你变多少。
        </p>
        <ExercisePicker
          open={moveFrom !== null}
          title=""
          exercises={lib?.exercises ?? []}
          muscles={lib?.taxonomy.muscles ?? []}
          prefer={[]}
          excludeIds={[]}
          onClose={() => setMoveFrom(null)}
          onPick={async (picked) => {
            const from = moveFrom;
            const movingSets = data?.sets.filter((s) => s.exerciseId === from?.exerciseId) ?? [];
            setMoveFrom(null);
            if (!from || picked.id === from.exerciseId) return;
            const volumeBefore = Math.round(
              movingSets.reduce((sum, s) => sum + (s.totalLoadKg ?? 0) * (s.reps ?? 0), 0),
            );
            const volumeAfter = Math.round(
              movingSets.reduce(
                (sum, s) =>
                  sum +
                  (totalLoadKg({
                    weightKg: s.weightKg,
                    loadMode: (picked.loadMode ?? "machine") as LoadMode,
                    barKg: picked.barKg,
                    semantics: semanticsForEquip(picked.equip),
                  }) ?? 0) *
                    (s.reps ?? 0),
                0,
              ),
            );
            const ok = await confirmDialog({
              title: `换成「${picked.name}」？`,
              body:
                `会把「${from.name}」这次记的 ${movingSets.length} 组搬到「${picked.name}」名下（组间歇一起带走；` +
                `器械变体不跟着搬，回到新动作的默认器械）。容量：${volumeBefore} → ${volumeAfter} kg（按新动作口径重算）。`,
            });
            if (ok) moveSets.mutate({ fromExerciseId: from.exerciseId, toExerciseId: picked.id });
          }}
        />
      </Sheet>

      <Sheet open={addOpen} title="加一个动作（补明细）" onClose={() => setAddOpen(false)}>
        <ExercisePicker
          open={addOpen}
          title=""
          exercises={lib?.exercises ?? []}
          muscles={lib?.taxonomy.muscles ?? []}
          prefer={[...new Set((data.exercises ?? []).flatMap((e) => e.muscles))]}
          excludeIds={(data.exercises ?? []).map((e) => e.exerciseId)}
          onClose={() => setAddOpen(false)}
          onPick={(picked) => {
            addExercise.mutate({ exerciseId: picked.id, name: picked.name, sets: picked.sets, reps: picked.reps });
            setAddOpen(false);
          }}
        />
      </Sheet>
    </main>
  );
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <div className="text-base font-bold">{value}</div>
      <div className="muted text-[11px]">{label}</div>
      {hint && <div className="muted text-[10.5px]">{hint}</div>}
    </div>
  );
}

/** 每组感受的小标签（FR-11）：吃力 / 力竭给个重色，一眼看出哪几组顶到头了 */
function FeelTag({ feel }: { feel: string }) {
  const label = FEEL_LABEL[feel];
  if (!label) return null;
  const strong = feel === "hard" || feel === "failure";
  return (
    <span
      className={`ml-1.5 rounded-full px-1.5 py-[1px] text-[10.5px] ${
        strong ? "bg-alert-soft text-alert" : "bg-bg text-muted"
      }`}
    >
      {label}
    </span>
  );
}
