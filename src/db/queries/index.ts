/**
 * 读查询总出口（issue #26）：按块拆到本目录下，这里统一 re-export ——
 * 调用方（/today、统计、页面服务端逻辑）的 `import ... from "@/db/queries"` 一个字都不用改。
 */

export * from "./part1";
export * from "./part2";
export * from "./part3";
export * from "./part4";
