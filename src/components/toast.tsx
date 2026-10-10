"use client";

/**
 * 轻量 toast（含「撤销」动作）。
 *
 * 13.8 要求顺延点击后 5 秒内可撤销；12.5 要求误删加班记录也能撤销 ——
 * 两者共用这个组件：`show(文案, { label: "撤销", onAction })`。
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface ToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}

interface ToastState {
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  show: (message: string, action?: ToastAction, ms?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, action?: ToastAction, ms = 5000) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, action });
    timer.current = setTimeout(() => setToast(null), ms);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[92px] z-60 flex justify-center px-4">
          <div className="pointer-events-auto inline-flex max-w-[88%] items-center gap-3 rounded-full bg-fg px-4 py-2.5 text-[13px] text-bg shadow-lg">
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => {
                  const action = toast.action;
                  setToast(null);
                  void action?.onAction();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}
