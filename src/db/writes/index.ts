/**
 * 写入口总出口（issue #26）：按领域拆到本目录下，这里统一 re-export ——
 * 调用方（路由 / 服务端逻辑）的 `import ... from "@/db/writes"` 一个字都不用改。
 */

export * from "./body";
export * from "./checkin";
export * from "./session";
export * from "./anchor";
export * from "./session-exercise";
export * from "./cardio";
export * from "./scheme";
export * from "./exercise";
export * from "./supplement";
export * from "./settings";
