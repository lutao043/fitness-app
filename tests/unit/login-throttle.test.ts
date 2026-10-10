/**
 * 登录失败节流（issue #32 / v1.45）：10 分钟内失败 5 次 → 锁 5 分钟。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LOCK_MS,
  MAX_FAILS,
  WINDOW_MS,
  loginThrottleCheck,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
} from "@/server/login-throttle";

const T0 = 1_700_000_000_000;

describe("滑动窗口（纯函数）", () => {
  it("不足阈值不锁；到阈值锁 5 分钟", () => {
    resetLoginThrottle();
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      expect(recordLoginFailure(T0 + i * 1000).blocked).toBe(false);
    }
    const locked = recordLoginFailure(T0 + MAX_FAILS * 1000);
    expect(locked.blocked).toBe(true);
    expect(locked.retryAfterSec).toBe(Math.ceil(LOCK_MS / 1000));
    expect(loginThrottleCheck(T0 + MAX_FAILS * 1000 + 1000).blocked).toBe(true);
  });

  it("锁定到期后放行（并清空窗口，从零开始数）", () => {
    resetLoginThrottle();
    for (let i = 0; i < MAX_FAILS; i++) recordLoginFailure(T0 + i);
    expect(loginThrottleCheck(T0 + MAX_FAILS + LOCK_MS + 1).blocked).toBe(false);
  });

  it("失败时刻散在窗口之外 → 不累计（10 分钟前的失败不算）", () => {
    resetLoginThrottle();
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      recordLoginFailure(T0 + i * (WINDOW_MS + 1000)); // 每次都在上一次的窗口之外
      expect(loginThrottleCheck(T0 + i * (WINDOW_MS + 1000)).blocked).toBe(false);
    }
  });

  it("登录成功清空计数", () => {
    resetLoginThrottle();
    for (let i = 0; i < MAX_FAILS - 1; i++) recordLoginFailure(T0 + i);
    recordLoginSuccess();
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      expect(recordLoginFailure(T0 + 1000 + i).blocked).toBe(false);
    }
  });

  it("未锁定时 retryAfterSec 不给（调用方不用猜）", () => {
    resetLoginThrottle();
    expect(loginThrottleCheck(T0)).toEqual({ blocked: false });
  });
});

describe("接口级：连错 5 次后连正确密码也拒（429）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fitness-throttle-"));
  process.env.DATABASE_FILE = join(dir, "throttle.sqlite");
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.APP_USERNAME = "me";

  function req(action: string, body: unknown) {
    return new Request(`http://localhost:3210/api/auth?action=${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  afterAll(async () => {
    try {
      const { getSqlite } = await import("@/db/client");
      getSqlite().close();
    } catch {
      // 没打开过就忽略
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("设密码 → 连错 5 次 → 第 6 次（含正确密码）都是 429", async () => {
    resetLoginThrottle();
    const { POST } = await import("@/app/api/auth/route");
    const setup = await POST(req("setup", { password: "correct-horse-battery" }));
    expect(setup.status).toBe(200);

    for (let i = 0; i < MAX_FAILS; i++) {
      const res = await POST(req("login", { password: "wrong" }));
      expect(res.status).toBe(401);
    }
    const locked = await POST(req("login", { password: "wrong" }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();

    // 关键：锁定期内**正确密码也不行**（否则等于允许"边试边等"）
    const correct = await POST(req("login", { password: "correct-horse-battery" }));
    expect(correct.status).toBe(429);
  });
});
