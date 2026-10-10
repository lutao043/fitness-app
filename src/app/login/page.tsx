"use client";

import { Suspense } from "react";

/**
 * 登录 / 首次设置密码（D2 / NFR-4）。
 *
 * 首次启动（库里没有密码）先让设一个；之后就是普通的登录表单。
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/client/api";

function LoginPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [state, setState] = useState<{ hasPassword: boolean | null; username: string }>({
    hasPassword: null,
    username: "me",
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ hasPassword: boolean; username: string }>("/api/auth")
      .then((s) => setState({ hasPassword: s.hasPassword, username: s.username }))
      .catch(() => setState({ hasPassword: true, username: "me" }));
  }, []);

  const isSetup = state.hasPassword === false;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (isSetup && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/auth?action=${isSetup ? "setup" : "login"}`, { password });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mt-16">
      <h1 className="text-2xl font-bold">健身助手</h1>
      <p className="muted mt-2 text-sm">
        {state.hasPassword === null
          ? "正在读取登录状态…"
          : isSetup
            ? "第一次使用，先设一个密码（只有你自己用）"
            : `你好，${state.username}。请输入密码`}
      </p>

      <form className="card mt-6 space-y-3" onSubmit={submit}>
        <label className="block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete={isSetup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isSetup ? "至少 6 位" : ""}
        />
        {isSetup && (
          <>
            <label className="block text-sm font-medium" htmlFor="confirm">
              再输一遍
            </label>
            <input
              id="confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </>
        )}
        {error && <p className="text-sm text-alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !password}>
          {busy ? "处理中…" : isSetup ? "设置密码并进入" : "登录"}
        </button>
      </form>

      <p className="muted mt-4 text-xs leading-relaxed">
        会话保持 30 天。外部助手 / 脚本走 <code>Authorization: Bearer</code> 通道，不受这里影响。
      </p>
    </main>
  );
}

/**
 * useSearchParams() 需要 Suspense 边界（Next 静态预渲染的硬要求），
 * 所以页面做成「壳 + 内容」两层。
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="card mt-10 h-40 animate-pulse" />}>
      <LoginPageInner />
    </Suspense>
  );
}
