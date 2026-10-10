/**
 * 可观测性日志（issue #1 第 7 项的建议落地）。
 *
 * - **一行一条 JSON**：`{ts, event, ...fields}`，落 `data/logs/app-YYYY-MM-DD.log`（按 Asia/Shanghai
 *   按天轮转）并镜像到 stdout（docker logs / json-file 里也看得到）；
 * - **记什么**：登录失败（401）、写接口校验拒绝（4xx）、服务端异常（5xx）、每日 cron 结果 ——
 *   带时间、路径、方法、状态码、错误摘要与最小上下文（ip / ua）；
 * - **不记什么**：请求体、密码、token、cookie 一律不落盘（出问题看代码，别看日志猜）；
 * - **永远不能影响请求**：写文件失败静默吞掉（磁盘满 / 权限问题不该把接口打挂）。
 * - 占用：保留最近 7 天，由每日 03:30 cron 调 `pruneOldLogs()` 清理（见 instrumentation-node.ts）；
 *   compose 侧另有 json-file max-size 兜底（见 docker-compose.yml 头部注释）。
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { addDays, dateInTz } from "@/lib/time";

export interface LogFields {
  event: string;
  path?: string;
  method?: string;
  status?: number;
  detail?: string;
  ip?: string;
  ua?: string;
  [key: string]: unknown;
}

export function logsDir(): string {
  return join(resolve(process.env.DATA_DIR ?? "./data"), "logs");
}

function writeLine(line: string): void {
  // stdout 先行：docker json-file 至少有这一份，文件写失败也不丢
  try {
    console.log(line);
  } catch {
    // console 都不可用时只能放弃
  }
  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `app-${dateInTz()}.log`), `${line}\n`);
  } catch {
    // 静默：日志永远不能影响请求本身
  }
}

export function logEvent(fields: LogFields): void {
  writeLine(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/** 从请求里取最小上下文（路径 / 方法 / ip / ua）——不含任何请求体与凭据 */
export function requestContext(request: Request): Pick<LogFields, "path" | "method" | "ip" | "ua"> {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    path: url.pathname,
    method: request.method,
    ip: forwarded || "direct",
    ua: (request.headers.get("user-agent") ?? "").slice(0, 120) || undefined,
  };
}

/**
 * 每日 cron 调用：删掉 7 天前的日志文件（按文件名里的日期判，不碰今天）。
 * `app-*.log`（可观测性）与 `changes-*.log`（数据修改日志，issue #40）**共用这一份实现**。
 */
export function pruneOldLogs(keepDays = 7): number {
  const cutoff = addDays(dateInTz(), -keepDays);
  let removed = 0;
  try {
    for (const name of readdirSync(logsDir())) {
      const match = /^(?:app|changes)-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (match && match[1] < cutoff) {
        unlinkSync(join(logsDir(), name));
        removed += 1;
      }
    }
  } catch {
    // 目录不存在 / 不可读就算了
  }
  return removed;
}
