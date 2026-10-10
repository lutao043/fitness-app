/**
 * PWA 外壳（NFR-2 / 需求书第 9 章选型 Serwist）里三处**配错了不会报错、只会悄悄坏**的地方，
 * 而且坏多半是在手机上才发现的 —— 所以钉成单测：
 *
 * ① 中间件放行名单：`sw.js` / `manifest.webmanifest` / `~offline` 少一个就坏一个。
 *    典型症状是"手机上装不了"，本机有登录 cookie 时完全测不出来（NFR-4 的守卫把入口一起拦了）。
 * ② 清单里声明的 `sizes` 与 public/icons 下的**实际文件**必须对得上：
 *    声明 192 实际是 512 这种错，浏览器只会静默拒绝安装，控制台都不一定有话说。
 * ③ 清单基本字段（中文名 / start_url / 独立窗口 / 一张 maskable）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/middleware";
import manifest from "@/app/manifest";

/**
 * 还原"这个路径会不会跑中间件"。
 * matcher 那串本身就是一条正则源（负向前瞻 = 放行名单），Next 编译它去匹配 pathname：
 * 命中 → 跑中间件（要登录），不命中 → 直接放行。
 */
function middlewareRunsOn(pathname: string): boolean {
  const raw = config.matcher;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") throw new Error("中间件 matcher 应为字符串形式的正则源");
  return new RegExp(`^${first}$`).test(pathname);
}

/** 读 PNG 头的 IHDR 段拿真实宽高（文件头 8 字节签名 + 4 字节长度 + "IHDR" + 宽 4 + 高 4） */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString("hex"), `${file} 不是 PNG`).toBe("89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("中间件放行名单（NFR-4：登录守卫不能把 PWA 的入口一起拦掉）", () => {
  const mustPass = [
    "/sw.js",
    "/manifest.webmanifest",
    "/favicon.ico",
    "/icons/icon-192.png",
    "/icons/icon-maskable-512.png",
    "/~offline",
  ];

  it.each(mustPass)("%s 不跑中间件（未登录也取得到）", (pathname) => {
    expect(middlewareRunsOn(pathname)).toBe(false);
  });

  // 反向用例：放行名单是"排除法"，写歪了很容易顺手把页面也放出去
  it.each(["/", "/history", "/body", "/session/1", "/settings/scheme", "/api/v1/today"])(
    "%s 仍然跑中间件（守卫没被放宽）",
    (pathname) => {
      expect(middlewareRunsOn(pathname)).toBe(true);
    },
  );
});

describe("PWA 清单（src/app/manifest.ts）", () => {
  const m = manifest();

  it("基本字段：中文名 / 起始页 / 独立窗口", () => {
    expect(m.name).toBe("健身助手");
    expect(m.short_name).toBe("健身助手");
    expect(m.lang).toBe("zh-CN");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("图标三张齐备，且含一张 maskable（Android 自适应图标）", () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.src)).toEqual([
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-maskable-512.png",
    ]);
    expect(icons.filter((i) => i.purpose === "maskable")).toHaveLength(1);
    expect(icons.filter((i) => i.purpose !== "maskable")).toHaveLength(2);
  });

  it("声明的 sizes 与 public/icons 下文件的真实尺寸一致", () => {
    for (const icon of m.icons ?? []) {
      const file = join(process.cwd(), "public", String(icon.src).replace(/^\//, ""));
      const { width, height } = pngSize(file);
      expect(`${width}x${height}`, `${icon.src} 的真实尺寸与清单声明不符`).toBe(icon.sizes);
    }
  });
});
