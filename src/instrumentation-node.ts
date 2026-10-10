/**
 * 容器内的定时任务（需求书第 9 章第 12 条：**统一在 instrumentation.ts 注册**）。
 *
 * 为什么不能写在路由模块顶层：standalone 下路由代码按需加载，写在里面可能根本不执行；
 * dev 下 HMR 又会重复注册。所以这里用 globalThis 守卫 + `register()`。
 *
 * 当前跑两件事：
 * 1. 每日任务（03:30，他睡觉的时间）：孤儿会话清理（4.2）+ `VACUUM INTO` 备份（NFR-5）
 *    + 日志清理（NFR-10：删 7 天前的 data/logs/app-*.log，issue #1 第 7 项）；
 * 2. 提醒滴答（每分钟，MVP+ 4.7）：调 `runReminderTick` 生成到点的提醒事件 ——
 *    判定复用 lib/reminder 纯函数且全程幂等（事件/投递都有唯一键），每分钟跑一次只为让
 *    「提醒时间」这个设置项改完立即生效（FR-40），不必为改配置去重排 cron；
 *    补剂时点一天多次，也靠这个 tick 逐个到点生成。 holiday_gap（13.12）同源于此。
 */

export async function register(): Promise<void> {
  const guard = globalThis as unknown as { __fitnessCronRegistered?: boolean };
  if (guard.__fitnessCronRegistered) return;
  guard.__fitnessCronRegistered = true;

  const { default: cron } = await import("node-cron");
  const { getDb } = await import("@/db/client");
  const { abortOrphanSessions } = await import("@/db/writes");
  const { makeBackup } = await import("@/db/backup");
  const { runReminderTick } = await import("@/server/reminders");
  const { logEvent, pruneOldLogs } = await import("@/server/logger");

  // 每天 03:30（Asia/Shanghai）—— 一天里最空闲的一段
  cron.schedule(
    "30 3 * * *",
    () => {
      try {
        const db = getDb();
        const aborted = abortOrphanSessions(db, Date.now());
        const backup = makeBackup(db);
        const prunedLogs = pruneOldLogs();
        logEvent({
          event: "cron.daily",
          detail: `孤儿会话 ${aborted} 条置为 aborted；备份 ${backup.file}（${Math.round(
            backup.bytes / 1024,
          )} KB，清理旧份 ${backup.pruned}）；清理旧日志 ${prunedLogs} 个文件`,
        });
      } catch (error) {
        logEvent({ event: "cron.daily_failed", detail: String(error) });
      }
    },
    { timezone: "Asia/Shanghai" },
  );

  // 提醒滴答：幂等，多跑无害；只在真的生成了事件时打日志
  cron.schedule(
    "* * * * *",
    () => {
      try {
        const tick = runReminderTick(getDb());
        for (const g of tick.generated) {
          logEvent({ event: "cron.reminder_generated", type: g.type, ref: g.refKey, date: g.date });
        }
      } catch (error) {
        logEvent({ event: "cron.reminder_tick_failed", detail: String(error) });
      }
    },
    { timezone: "Asia/Shanghai" },
  );

  logEvent({
    event: "cron.registered",
    detail: "03:30 清理孤儿会话 + VACUUM INTO 备份 + 清理 7 天前日志；每分钟提醒滴答（判定幂等，改提醒时间立即生效）",
  });

  // 未处理的 Promise 拒绝也留痕（issue #1 第 7 项）——只记日志，不改进程退出语义
  process.on("unhandledRejection", (reason) => {
    logEvent({ event: "process.unhandled_rejection", detail: String(reason) });
  });
}
