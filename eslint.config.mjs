import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "data/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "docs/**",
      "next-env.d.ts",
      // Service Worker 是 `pnpm build:sw` 打包出来的压缩产物（见 .gitignore），不是源码
      "public/sw.js",
      "public/sw.js.map",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // 硬约束（开发计划 §3）：src/lib/** 是纯领域逻辑，不得依赖 React、Next、数据库。
    // 这是「排期引擎必须可脱离数据库单测」（需求书第 9 章第 3 条）成立的前提。
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "src/lib/** 是纯领域逻辑，不得依赖 React（开发计划 §3）。" },
            { name: "react-dom", message: "src/lib/** 是纯领域逻辑，不得依赖 React（开发计划 §3）。" },
            { name: "next", message: "src/lib/** 是纯领域逻辑，不得依赖 Next（开发计划 §3）。" },
            { name: "drizzle-orm", message: "src/lib/** 不得依赖数据库（开发计划 §3）。" },
            { name: "better-sqlite3", message: "src/lib/** 不得依赖数据库（开发计划 §3）。" },
          ],
          patterns: [
            { group: ["next/*"], message: "src/lib/** 是纯领域逻辑，不得依赖 Next（开发计划 §3）。" },
            { group: ["@/db", "@/db/*"], message: "src/lib/** 不得依赖数据库层（开发计划 §3）。" },
            { group: ["@/app/*", "@/components/*"], message: "src/lib/** 不得依赖页面/组件层（开发计划 §3）。" },
            { group: ["node:fs", "node:fs/*", "node:path", "node:os"], message: "src/lib/** 保持纯函数，不做文件系统访问（开发计划 §3）。" },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;
