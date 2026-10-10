/**
 * 登录失败节流（issue #32 / v1.45）。
 *
 * 场景：局域网里风险低，但密码是**单用户唯一防线** —— 日后挂反向代理暴露到公网，
 * 没有节流就等于允许无限次暴力尝试。这里只做进程内的滑动窗口（**不引任何依赖、不加表**）：
 *
 * - 窗口：`WINDOW_MS`（10 分钟）内失败达到 `MAX_FAILS`（5 次）→ 锁定 `LOCK_MS`（5 分钟）；
 * - 锁定期内**一律拒绝**（连正确密码也拒，避免"边试边等正确密码"）；剩余时间如实告诉调用方；
 * - 成功登录清空窗口；**进程重启即清零**（单用户自托管，够用且最简单 —— 要跨重启就得落库，
 *   而那会引入"锁定状态被写坏"这类新问题，见 issue 的取舍）。
 *
 * 纯逻辑放这里（可单测），路由只负责调用与记日志。
 */

export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_FAILS = 5;
export const LOCK_MS = 5 * 60 * 1000;

interface State {
  /** 窗口内的失败时刻（毫秒） */
  fails: number[];
  /** 锁定到期时刻；null = 未锁定 */
  lockedUntil: number | null;
}

const state: State = { fails: [], lockedUntil: null };

export interface ThrottleDecision {
  /** 是否拒绝本次尝试 */
  blocked: boolean;
  /** 距离解锁还有多少秒（blocked 时有值） */
  retryAfterSec?: number;
}

/** 记一次失败；返回失败之后的决定（满 5 次即进入锁定） */
export function recordLoginFailure(now: number): ThrottleDecision {
  if (state.lockedUntil !== null && now >= state.lockedUntil) {
    // 锁定期已过：重置（连同窗口一起清，从零开始数）
    state.lockedUntil = null;
    state.fails = [];
  }
  state.fails = state.fails.filter((t) => now - t < WINDOW_MS);
  state.fails.push(now);
  if (state.fails.length >= MAX_FAILS) {
    state.lockedUntil = now + LOCK_MS;
    state.fails = [];
  }
  return decisionAt(now);
}

/** 这次请求放不放行（锁定期内不放行） */
export function loginThrottleCheck(now: number): ThrottleDecision {
  return decisionAt(now);
}

/** 登录成功：清空窗口与锁定 */
export function recordLoginSuccess(): void {
  state.fails = [];
  state.lockedUntil = null;
}

function decisionAt(now: number): ThrottleDecision {
  if (state.lockedUntil !== null && now < state.lockedUntil) {
    return { blocked: true, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
  }
  if (state.lockedUntil !== null) {
    state.lockedUntil = null; // 已过期，顺手清掉
  }
  return { blocked: false };
}

/** 仅供单测：把状态清干净 */
export function resetLoginThrottle(): void {
  state.fails = [];
  state.lockedUntil = null;
}
