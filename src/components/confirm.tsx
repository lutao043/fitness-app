"use client";

/**
 * 页面内二次确认（issue #1 第 6 项：替代原生 window.confirm）。
 *
 * 原生 confirm 是同步阻塞的 —— 自动化工具会卡死线程，手机上观感也偏"系统弹窗"。
 * 这里用 Promise 化的页面内确认层：`const ok = await confirm({ title: "删掉这一组？" })`，
 * 调用点写法与 window.confirm 一致，只是多了 await。所有会弹确认的页面都在
 * 根布局的 <ConfirmProvider> 之下（与 ToastProvider 同级）。
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface ConfirmOptions {
  title: string;
  /** 补充说明（会换行显示） */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（确认键用警示色） */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm 必须在 <ConfirmProvider> 内使用");
  return ctx;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    // 连续触发时把前一个按"取消"结掉，避免 Promise 悬着
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const item = { ...options, resolve };
      pendingRef.current = item;
      setPending(item);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-70 flex items-center justify-center bg-black/40 px-6"
          data-testid="confirm-layer"
          onClick={() => settle(false)}
        >
          <div
            className="card w-full max-w-[320px] rounded-2xl p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold">{pending.title}</div>
            {pending.body && (
              <div className="muted mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed">{pending.body}</div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="btn btn-secondary flex-1"
                data-testid="confirm-cancel"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                type="button"
                className={`btn flex-1 ${pending.danger ? "btn-danger" : "btn-primary"}`}
                data-testid="confirm-accept"
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
