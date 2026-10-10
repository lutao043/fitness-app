/**
 * 记一组的幂等键（第 7 章「所有写接口可安全重试」/ 13.1 / issue #34）。
 *
 * **必须是确定性的**：同一组（同一场会话 × 动作 × 器械变体 × 组号）的重复提交 ——
 * 手滑连点、离线队列重放、网络重试 —— 都要算出**同一个键**，服务端才认得出"这是同一组"。
 *
 * 反例（issue #34 的根因）：键尾拼了 `Date.now()`，每次点击都在变 → 连点两下被当成两组，
 * 库里落下两条 `set_no` 相同的行。
 *
 * 语义：同键复用 = **改组**（与 `PATCH /sets/{setId}` 一致）；组号只增不减，所以不会
 * 出现"新的一组建模到旧键上"。
 */
export function setClientKey(input: {
  clientId: string | number;
  exerciseId: number;
  variantId?: number | null;
  setNo: number;
}): string {
  return `${input.clientId}:${input.exerciseId}:${input.variantId ?? "d"}:${input.setNo}`;
}
