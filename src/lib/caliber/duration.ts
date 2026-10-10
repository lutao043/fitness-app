/**
 * 训练时长（13.3，v1.34 / issue #38）。
 *
 * 口径：**墙上时间 = `ended_at − started_at`，含组间歇的暂停**。
 * - 与 FR-42 / 13.5 的「组间歇扣暂停」**不是一回事**：那个只作用于 `set_log.rest_before_sec`，
 *   这里的暂停照算（他用「暂停」只是不想让组间歇均值被拉长，不是"这次训练没发生"）；
 * - 两个时间戳缺一 / 不可解析 → **null**：读侧显示「—」。不许拿"现在"倒推（会让昨天没收工的
 *   会话今天显示成 20 小时），也不许把"缺时间"显示成 `0 分钟` 冒充（0 是"练了不到半分钟"）；
 * - 跨零点按两个时间戳相减，**不按自然日切分**（13.3：23:40 开练 → 00:20 收工 = 40 分钟）。
 */

/** 训练时长（秒）。拿不到就给 null —— 调用方负责显示「—」 */
export function sessionDurationSec(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): number | null {
  if (!startedAt || !endedAt) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  // ended < started（时钟回拨 / 脏数据）：按 0 秒算，不给负数
  return Math.max(0, Math.round((ended - started) / 1000));
}

/** 时长文案（小结 / 详情 / 今日卡共用）：拿不到给「—」，不显示 0 分钟冒充 */
export function durationMinutesText(durationSec: number | null | undefined): string {
  if (durationSec === null || durationSec === undefined) return "—";
  return `${Math.round(durationSec / 60)} 分钟`;
}
