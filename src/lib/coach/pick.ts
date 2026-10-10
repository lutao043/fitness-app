/**
 * 鼓励语选取（issue #33 / v1.39）。
 *
 * 两条硬要求：
 * - **相邻不重复**：同一场训练里连着两次拿到同一句，比没有这句话还尴尬；
 * - **池空有兜底**：文案库被整批换空 / 换了坏数据时，页面不能空一块，给一句内置的。
 *
 * 纯函数、不依赖 React / DB（`src/lib/**` 的 lint 强制），种子由调用方给（用倒计时的终点时间戳，
 * 每次休息都不一样，但同一场休息刷新页面结果稳定）。
 */

/** 文案池空 / 坏数据时的兜底（不命令式、不说教） */
export const ENCOURAGEMENT_FALLBACK = "歇着也是训练的一部分";

/**
 * 从文案池里挑一句。
 * @param pool 文案池（空串 / 非字符串会被忽略）
 * @param seed 种子（用倒计时终点这种"每次都不一样、但同一场稳定"的数）
 * @param previous 上一句（= 它的话就顺延一句，保证相邻不重复）
 */
export function pickEncouragement(
  pool: readonly unknown[],
  seed: number,
  previous?: string | null,
): string {
  const lines = pool.filter((l): l is string => typeof l === "string" && l.trim() !== "");
  if (lines.length === 0) return ENCOURAGEMENT_FALLBACK;
  const idx = Math.abs(Math.floor(Number.isFinite(seed) ? seed : 0)) % lines.length;
  if (previous != null && lines.length > 1 && lines[idx] === previous) {
    return lines[(idx + 1) % lines.length];
  }
  return lines[idx];
}
