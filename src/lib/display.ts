/**
 * 展示层的数字格式与文案拼装（issue #25）。
 *
 * 这些原来都写在页面组件文件里 —— "算出来给用户看"的分支放在组件里，天生不可测；
 * 搬到 `src/lib/**`（纯逻辑层，lint 强制不依赖 React / Next / DB）之后可以单测。
 */

import { volumeToDisplay, type WeightUnit } from "@/lib/units";

/** 大数字缩写：10000 以上给「16.5k」（记录页统计卡用） */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n >= 10000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/**
 * 记录页每一行的次要信息：有重量数据给「容量 X kg」，否则退回训练场景
 * （自重日显示「居家自重」，其余「健身房」）—— 不再显示 `0 kg` 这种误导数字（issue #35 同源口径）。
 */
export function sessionRowMeta(
  row: { volumeKg?: number | null; mode?: string | null },
  unit: WeightUnit,
): string {
  if (row.volumeKg) return `容量 ${volumeToDisplay(row.volumeKg, unit)} ${unit}`;
  return row.mode === "home" ? "居家自重" : "健身房";
}
