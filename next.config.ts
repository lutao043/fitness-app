import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NFR-1 / 需求书第 9 章：Docker 单容器部署，standalone 产物
  output: "standalone",
  // 原生模块不进 bundle（better-sqlite3 要读自带的 prebuilds/*.node，argon2 是 napi 包）
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2"],
  // instrumentation.ts（注册 node-cron 的地方）走的是另一条打包路径，
  // serverExternalPackages 管不到它，这里再显式声明一次原生模块与定时库为 external。
  // 注意：edge 编译也要算上 —— 不声明的话 edge 那份会去打包原生模块，报 "Can't resolve 'fs'"。
  // 运行时不会真的在 edge 里执行（instrumentation 里先判了 NEXT_RUNTIME）。
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(config.externals ?? []),
        "better-sqlite3",
        "@node-rs/argon2",
        "node-cron",
      ];
    }
    return config;
  },
  eslint: {
    // lint 由 `pnpm check`（eslint .）统一跑，构建时不重复跑一遍
    ignoreDuringBuilds: true,
  },
  // 开发时手机通过局域网 IP / 127.0.0.1 访问会被 Next 当成跨域来源（只影响 dev 提示）
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.local"],
  // 全中文界面（NFR-3），React 自带的开发提示保留即可
  reactStrictMode: true,
};

export default nextConfig;
