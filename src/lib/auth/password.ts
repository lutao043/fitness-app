/**
 * 密码与 token 的哈希（需求书第 9 章：argon2；D2：单用户用户名 + 密码）。
 *
 * 用 @node-rs/argon2（预编译原生包，MIT）而不是 node-argon2：不需要 node-gyp 工具链，
 * Windows 开发机与 Linux 容器里都能直接跑。
 */

import { hash, verify } from "@node-rs/argon2";

/** argon2id 默认参数对单用户足够（内存 19MB、迭代 2 次、并行 1） */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

export function passwordIssue(password: string): string | null {
  if (typeof password !== "string" || password.length < 6) return "密码至少 6 位";
  if (password.length > 200) return "密码太长";
  return null;
}
