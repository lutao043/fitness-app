"use client";

/**
 * 改练其他部位（FR-4 / 原型 sheetPart；需求书 4.2「换部位」也指这里）。
 *
 * 今天想练别的部位：列出当前方案里的**非休槽位**（部位名 + 细分肌群 + 动作清单），
 * 选中 → 带上 `?part=<槽位 id>` 进开练流程。
 * **只影响今天这一次**：不重锚循环、不动锚点，下次仍按原循环位继续
 * （想固定改排期去「我的 → 方案与槽位编辑」）。
 */

import { useQuery } from "@tanstack/react-query";
import { api, qk, type SchemeAdmin } from "@/client/api";
import { Sheet } from "@/components/ui";

export function PartPicker({
  open,
  onClose,
  onPick,
  /** 今天排期上本来就是哪个部位（给「今天就是它」打个标） */
  currentPart,
  /** 预览哪套清单（与开练页的场景保持一致，别预览健身房却开居家） */
  mode,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (slot: SchemeAdmin["slots"][number]) => void;
  currentPart: string;
  mode: "gym" | "home";
}) {
  // 槽位清单只在打开时取（91 条动作不必随首页加载体）
  const { data } = useQuery({
    queryKey: qk.schemes(),
    queryFn: () => api.get<{ schemes: SchemeAdmin[]; activeSchemeId: string | null }>("/api/v1/schemes"),
    enabled: open,
  });
  const scheme = data?.schemes.find((s) => s.id === data.activeSchemeId) ?? data?.schemes.find((s) => s.active) ?? null;
  const slots = (scheme?.slots ?? []).filter((s) => !s.rest);

  return (
    <Sheet open={open} title="改练其他部位" onClose={onClose}>
      <p className="muted text-[12px] leading-relaxed">
        今天改练别的部位<span className="font-semibold">不会重锚循环</span>；下次仍按原循环位继续。
        想固定改排期，就去「我的 → 方案与槽位编辑」。
      </p>
      <div className="mt-3 space-y-2">
        {slots.map((slot) => {
          const list = mode === "home" ? slot.home : slot.gym;
          const isCurrent = slot.label === currentPart;
          return (
            <button
              key={slot.templateId}
              type="button"
              className={`w-full rounded-xl border px-3 py-2 text-left ${
                isCurrent ? "border-accent bg-accent-soft" : "border-border"
              }`}
              onClick={() => onPick(slot)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px] font-semibold">
                  {slot.label}
                  {isCurrent && <span className="muted ml-2 text-[11.5px] font-normal">今天就是它</span>}
                </span>
                <span className="muted shrink-0 text-[11.5px]">{list.length} 个动作</span>
              </div>
              <div className="muted mt-0.5 text-[11.5px]">{slot.muscles.join(" + ") || "没标肌群"}</div>
              {list.length > 0 && (
                <div className="muted mt-1 text-[11.5px] leading-relaxed">
                  {list
                    .map((e) => `${e.name} ${e.targetSets}×${e.targetReps}${e.type === "time" ? " 秒" : ""}`)
                    .join(" · ")}
                </div>
              )}
            </button>
          );
        })}
        {scheme && slots.length === 0 && (
          <div className="muted text-[12.5px]">当前方案里没有可练的槽位（都是「休」）· 去规则管理里加。</div>
        )}
      </div>
      <a
        className="mt-3 block text-center text-[12px] text-accent underline underline-offset-2"
        href="/settings/scheme"
      >
        去方案与槽位编辑
      </a>
    </Sheet>
  );
}
