/**
 * 训练页的「记组 / 倒计时」两态与暂停语义（issue #33 / v1.39）。
 *
 * 三条口径（都对得上出处）：
 * - **态由绝对时间戳判定**，不用内存 state（第 9 章第 7 条、第 12 章第 21 条、交互设计说明 §2）：
 *   冷启动 / 锁屏 / 切 App / 刷新回来时，`restEnd > now` 就是倒计时态，否则记组态；
 * - **倒计时不可重启**：进倒计时态的唯一入口是「完成一组」且该组成功落库；档位只影响下一次；
 *   「跳过休息」= 终止当前倒计时（不是重来）；
 * - **暂停 = 冻结剩余量**（FR-42，issue #33 的补充）：把"还剩多少"存成 `restRemainMs` 再清空 `restEnd`；
 *   继续时按剩余量重算终点 —— 不是从 90s 重头数、也不是归零。暂停时长仍只通过 `paused_ms_since_prev`
 *   从组间歇里扣一次（13.5 口径不变）。
 */

export type SessionPhase = "rest" | "record";

export interface RestState {
  /** 倒计时终点（绝对时间戳）；暂停中为 null；老 localStorage 里可能整个字段都没有 */
  restEnd?: number | null;
  /** 暂停时冻结的剩余毫秒（暂停中才有值）；老 localStorage 里没有 = 没在暂停 */
  restRemainMs?: number | null;
}

/** 现在该显示哪一态：暂停中也算倒计时态（数字停住不动） */
export function sessionPhase(state: RestState, now: number): SessionPhase {
  if (state.restRemainMs != null && state.restRemainMs >= 0) return "rest";
  if (state.restEnd != null && state.restEnd > now) return "rest";
  return "record";
}

/** 剩余秒数（向上取整，给倒计时显示用）；不在倒计时里给 0 */
export function restRemainingSec(state: RestState, now: number): number {
  if (state.restRemainMs != null && state.restRemainMs >= 0) {
    return Math.max(0, Math.ceil(state.restRemainMs / 1000));
  }
  if (state.restEnd != null && state.restEnd > now) {
    return Math.max(0, Math.ceil((state.restEnd - now) / 1000));
  }
  return 0;
}

/** 暂停：冻结剩余量（`restEnd` 清空，`restRemainMs` 接住） */
export function pauseRest(state: RestState, now: number): { restEnd: null; restRemainMs: number } {
  const remain = state.restRemainMs != null && state.restRemainMs >= 0
    ? state.restRemainMs
    : Math.max(0, (state.restEnd ?? now) - now);
  return { restEnd: null, restRemainMs: remain };
}

/** 继续：按冻结的剩余量重算终点（**从暂停那一刻的剩余接着走**，不是重启也不是归零） */
export function resumeRest(state: RestState, now: number): { restEnd: number | null; restRemainMs: null } {
  const remain = state.restRemainMs;
  if (remain == null || remain < 0) return { restEnd: null, restRemainMs: null };
  return { restEnd: now + remain, restRemainMs: null };
}

/** 跳过休息 / 落库新一组：终止倒计时（不是重来） */
export function stopRest(): { restEnd: null; restRemainMs: null } {
  return { restEnd: null, restRemainMs: null };
}
