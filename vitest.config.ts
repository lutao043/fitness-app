import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
    // 首个用例要付原生模块（better-sqlite3 / argon2）与建库的初始化成本，默认 5s 偶发不够；
    // beforeAll 里建库 + 注入种子的文件（api / rules / cardio / session-edit…）同样吃这个成本，
    // 多文件并行时 hook 的默认 10s 也会偶发超时
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /**
     * 覆盖率**只观测、不设阈值、不进 CI 门禁**（issue #30）：
     * 设阈值会让 AI 为了过门禁去写凑数的测试，收益为负。
     * 本地 `pnpm coverage` 看报告；观察重点是"哪些大件从没被测到"（如 db/queries.ts）。
     */
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/app/**"], // 页面（React 组件）靠手工验收，不计入观测口径
    },
  },
});
