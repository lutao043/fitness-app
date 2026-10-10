/**
 * 校验层总出口（issue #26）：按领域拆到本目录下，这里统一 re-export ——
 * 调用方（路由 / server 逻辑 / 单测）的 `import ... from "@/server/rules"` 一个字都不用改。
 */

export * from "./core";
export * from "./exercise";
export * from "./scheme";
export * from "./supplement";
export * from "./records";
