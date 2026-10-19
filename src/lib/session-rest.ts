/**
 * 训练页的「待开始 / 进行中 / 休息」三态与暂停语义（issue #33 / v1.39 两态；issue #75 / v1.50 三态）。
 *
 * 四条口径（都对得上出处）：
 * - **态由绝对时间戳判定**，不用内存 state（第 9 章第 7 条、第 12 章第 21 条、交互设计说明 §2）：
 *   冷启动 / 锁屏 / 切 App / 刷新回来时，`restEnd > now` 就是休息态；
 *   否则「有开始时刻且未结束」= 进行中态（按 `now - setStartedAt` 反算，不重置、不归零）；
 *   否则待开始态；
 * - **休息倒计时的唯一入口是「结束这组」且该组成功落库**（FR-9 v1.50：点【开始这组】不起倒计时）；
 *   档位只影响下一次；「跳过休息」= 终止当前倒计时（不是重来）；
 * - **一组完成、清单里还有待做动作**才起倒计时：最后一组记完直接进收工态（FR-12 v1.50 / issue #77，
 *   判定在落库后由 `shouldFinish` 给出，见 `session-progress.ts` 的 `phaseAfterSet`）；
 * - **暂停 = 冻结剩余量**（FR-42，issue #33 的补充）：把"还剩多少"存成 `restRemainMs` 再清空 `restEnd`；
 *   继续时按剩余量重算终点 —— 不是从 90s 重头数、也不是归零。暂停时长仍只通过 `paused_ms_since_prev`
 *   从组间歇里扣一次（13.5 口径不变）。**暂停只作用于休息态**（进行中不引入暂停，FR-42 v1.50）。
 */

export type SessionPhase = "rest" | "doing" | "record";

/**
 * 进行中态的异常收口（FR-9 v1.50 / issue #75 需求 2）：挂超过 2 小时 = 僵尸态，
 * 自动回待开始、这一组不落库（避免"进行中 5 小时"）。纯函数判定，页面负责把过期的开始时刻清掉。
 */
export const DOING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface RestState {
  /** 倒计时终点（绝对时间戳）；暂停中为 null；老 localStorage 里可能整个字段都没有 */
  restEnd?: number | null;
  /** 暂停时冻结的剩余毫秒（暂停中才有值）；老 localStorage 里没有 = 没在暂停 */
  restRemainMs?: number | null;
  /** 本组开始时刻（进行中态才有值）；老 localStorage 里没有 = 没在记组中 */
  setStartedAt?: number | null;
}

/** 现在该显示哪一态：暂停中也算休息态（数字停住不动）；进行中挂超时按待开始算 */
export function sessionPhase(state: RestState, now: number): SessionPhase {
  if (state.restRemainMs != null && state.restRemainMs >= 0) return "rest";
  if (state.restEnd != null && state.restEnd > now) return "rest";
  const start = state.setStartedAt;
  if (start != null && now >= start && now - start < DOING_TIMEOUT_MS) return "doing";
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

/** 本组已做秒数（向下取整，给进行中计时用）；没在记组中 / 时钟回拨给 0 */
export function doingElapsedSec(state: RestState, now: number): number {
  const start = state.setStartedAt;
  if (start == null || now < start) return 0;
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** 开始这组：记下绝对开始时刻（进行中态的唯一入口） */
export function startDoing(now: number): { setStartedAt: number } {
  return { setStartedAt: now };
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

/** 跳过休息 / 结束这组落库：终止倒计时（不是重来）；一组结束也把这次记组的开始时刻一起清掉 */
export function stopRest(): { restEnd: null; restRemainMs: null; setStartedAt: null } {
  return { restEnd: null, restRemainMs: null, setStartedAt: null };
}
