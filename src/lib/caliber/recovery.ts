/**
 * 恢复度（需求书 13.9 / FR-18 / FR-19）。
 *
 * - 起点 = 该部位**最近一次训练的 `ended_at`**（不是固定时刻 —— 居家上午 10:00 练完，
 *   当天 20:00 就该显示约 10 小时，而不是 0 小时）；
 * - 阈值随循环长度参数化，**不写死 48/72**：设该部位的轮转间隔 G 天（取槽位数），
 *   `< 0.5G` 恢复中（橙） / `0.5G ~ 0.75G` 基本恢复（黄） / `> 0.75G` 已恢复（绿）；
 *   四天循环下 = 48h / 72h（与旧口径一致）；
 * - 无记录的部位显示"无记录"，不要假装"已恢复"。
 */

export interface RecoveryThresholds {
  /** 恢复中 / 基本恢复 的分界（小时） */
  alertHours: number;
  /** 基本恢复 / 已恢复 的分界（小时） */
  recoveredHours: number;
}

export function recoveryThresholdsFor(cycleLen: number): RecoveryThresholds {
  const g = cycleLen > 0 ? cycleLen : 4;
  return { alertHours: 0.5 * g * 24, recoveredHours: 0.75 * g * 24 };
}

export type RecoveryKey = "none" | "recovering" | "mostly" | "recovered";

export interface RecoveryState {
  key: RecoveryKey;
  label: string;
  /** 距上次练完的小时数（无记录 → null） */
  hoursSince: number | null;
  /** 进度条百分比（0~100；无记录 → 0） */
  pct: number;
}

export function hoursSinceEnded(endedAt: number, now: number): number {
  return Math.max(0, Math.round((now - endedAt) / 3_600_000));
}

export function recoveryState(
  endedAt: number | null,
  now: number,
  cycleLen: number,
): RecoveryState {
  if (endedAt === null) {
    return { key: "none", label: "无记录", hoursSince: null, pct: 0 };
  }
  const h = hoursSinceEnded(endedAt, now);
  const t = recoveryThresholdsFor(cycleLen);
  const pct = Math.min(100, Math.max(4, Math.round((h / t.recoveredHours) * 100)));
  if (h < t.alertHours) return { key: "recovering", label: "恢复中", hoursSince: h, pct };
  if (h < t.recoveredHours) return { key: "mostly", label: "基本恢复", hoursSince: h, pct };
  return { key: "recovered", label: "已恢复", hoursSince: h, pct };
}
