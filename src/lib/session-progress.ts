/**
 * 训练页的组数表述（issue #37 / v1.36）。
 *
 * 三处都会说"几组"，以前用的是同一种 `N/M` 形状，分不清谁是谁：
 * - **全场进度**：`已完成 4 组，共 16 组`（今天整份清单）
 * - **本动作**：`第 2 组 · 共 4 组`（只在这里出现"第几组"）
 * - **做满之后**：不再说"第几组"（没有"第 5 组"这回事），改成 `本动作 4 组已完成`
 *
 * 放在 lib 里是为了能单测（`src/lib/**` 不许依赖 React/DB）。
 */

/** 全场进度（顶部）：不说"第几组"，也不写成 `4/16 组` 这种和动作卡同形的分数 */
export function overallSetText(doneSets: number, totalSets: number): string {
  return `已完成 ${doneSets} 组，共 ${totalSets} 组`;
}

/**
 * 本动作的组数（记组卡首行）：未做满给「第 N 组 · 共 M 组」，做满给「本动作 M 组已完成」；
 * `extraSet` = 他在收工态点了「再练一组」（issue #39），这时明说"再加一组"而不是又说一次"已完成"。
 */
export function exerciseSetText(
  doneSets: number,
  targetSets: number,
  opts: { extraSet?: boolean } = {},
): string {
  if (doneSets >= targetSets) {
    return opts.extraSet ? `再加一组 · 本动作已做满 ${targetSets} 组` : `本动作 ${targetSets} 组已完成`;
  }
  return `第 ${Math.min(doneSets + 1, targetSets)} 组 · 共 ${targetSets} 组`;
}

/**
 * 收工态的判定（issue #39 / v1.40）：**所有动作都做满目标组数、或清单为空** → 该收工了。
 * 用户点过「再练一组」时由调用方把 `extraSet` 传进来压掉它（他想多做一组，别把路堵死）。
 */
export function shouldFinish(
  exercises: readonly { doneSets: number; targetSets: number }[],
  opts: { extraSet?: boolean } = {},
): boolean {
  if (opts.extraSet) return false;
  return exercises.every((e) => e.doneSets >= e.targetSets);
}

/** 「完成一组」按钮的文案：做满 / 落库中 / 刚落库 / 可点 */
export function completeSetLabel(input: {
  exerciseDone: boolean;
  pending: boolean;
  justRecorded: boolean;
}): string {
  if (input.exerciseDone) return "本动作已做满 · 可以收工了";
  if (input.pending) return "记下中…";
  if (input.justRecorded) return "已记下 ✓";
  return "✓ 完成一组";
}

/**
 * 完成度（issue #45 / v1.47）：记录页/今日页的主指标 —— 总容量那类"越练越唬人"的数不该占主位。
 *
 * - **主标** = 已记组数 / 目标组数之和（目标之和为 0 时不给数，显示「—」）；
 * - **副标** = 做满的动作数 / **参与动作数**，分母**只算本次记过组的动作**：
 *   已收工的会话里可能残留 0 组的"僵尸动作行"（老数据 / 历史操作留下的），
 *   把它算进分母会让完成度被无理由拉低（实测出现过 5/6 而不是 5/5）。
 * - 容量照旧在服务端算、进导出与统计，这里只决定"展示成什么"。
 */
export interface CompletionRow {
  /** 本次记过组（set_log 里出现过） */
  hasSets: boolean;
  /** 已记正式组数（不含热身行，13.16） */
  doneSets: number;
  /** 本动作的目标组数 */
  targetSets: number;
}

export function sessionCompletion(
  rows: readonly CompletionRow[],
  totalSets: number,
): { setsText: string; exercisesText: string } {
  const targetSum = rows.reduce((sum, r) => sum + r.targetSets, 0);
  const participants = rows.filter((r) => r.hasSets);
  const filled = participants.filter((r) => r.doneSets >= r.targetSets).length;
  return {
    setsText: targetSum > 0 ? `${totalSets}/${targetSum} 组` : "—",
    exercisesText: participants.length > 0 ? `${filled}/${participants.length} 动作做满` : "—",
  };
}
