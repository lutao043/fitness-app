"use client";

/**
 * 加班记录面板（录 / 改共用，FR-22 / 3.3 / 交互设计说明 §12.4）。
 *
 * 首页时间胶囊一点即录仍是主路径（不打字）；这个面板管「其他时间 / 改 / 补录历史」：
 * 日期（今天 / 明天 胶囊 + 日期选择器）、开始时间（常用胶囊 + 时间输入）、备注选填，
 * 底部是判定预告（`lib/overtime` 的纯函数）—— 保存前就知道这条记录会不会让当晚被催。
 * 编辑态页脚是「取消 / 删除 / 保存」，删完直接落到列表（§12.4）。
 *
 * 保存与删除都是**调用方的事**（POST / PATCH / DELETE + toast + 5 秒撤销）：
 * 这样首页与「我的」两处共用同一个面板、同一套校验，却各自沿用已有的列表刷新与撤销逻辑。
 */

import { useState } from "react";
import { OVERTIME_QUICK_TIMES, overtimeDateLabel, overtimePreviewText, overtimeVerdictText } from "@/lib/overtime";
import { addDays, dateInTz, isValidTimeStr } from "@/lib/time";
import { Pill, Sheet } from "@/components/ui";

export interface OvertimeDraft {
  /** null = 新建（首页「其他时间…」/「我的 → 加班记录 → 添加」） */
  id: number | null;
  date: string;
  start: string;
  note: string | null;
}

export function OvertimeEditor({
  draft,
  onClose,
  onSubmit,
  onDelete,
  dayTypeOf,
}: {
  /** null = 面板关闭；只要有值就是打开状态 */
  draft: OvertimeDraft | null;
  onClose: () => void;
  /** 保存：新建走 POST、编辑走 PATCH（调用方决定；失败时不要关面板，toast 报原因） */
  onSubmit: (draft: OvertimeDraft) => void;
  /** 只有编辑态给：删除（toast 与 5 秒撤销由调用方负责，§12.5） */
  onDelete?: (draft: OvertimeDraft) => void;
  /**
   * 某天是训练日 / 休息日 / 假期（13.11 / v1.20）：休息日与假期只作记录，
   * 判定预告不提"耽误训练"。拿不准的日期给 null → 按训练日的老文案（保守）。
   */
  dayTypeOf?: (date: string) => "training" | "rest" | "holiday" | null;
}) {
  return (
    <Sheet
      open={draft !== null}
      title={draft && draft.id !== null ? "改加班记录" : "记一条加班"}
      onClose={onClose}
    >
      {/* key：换一条记录就重置表单，开着面板切目标不会把上一条的备注带过去 */}
      {draft && (
        <OvertimeForm
          key={draft.id ?? `${draft.date}-${draft.start}`}
          draft={draft}
          onClose={onClose}
          onSubmit={onSubmit}
          onDelete={onDelete}
          dayTypeOf={dayTypeOf}
        />
      )}
    </Sheet>
  );
}

function OvertimeForm({
  draft,
  onClose,
  onSubmit,
  onDelete,
  dayTypeOf,
}: {
  draft: OvertimeDraft;
  onClose: () => void;
  onSubmit: (draft: OvertimeDraft) => void;
  onDelete?: (draft: OvertimeDraft) => void;
  dayTypeOf?: (date: string) => "training" | "rest" | "holiday" | null;
}) {
  const [date, setDate] = useState(draft.date);
  const [start, setStart] = useState(draft.start);
  const [note, setNote] = useState(draft.note ?? "");
  const today = dateInTz();
  const startOk = isValidTimeStr(start);
  const changed = date !== draft.date || start !== draft.start || note !== (draft.note ?? "");
  // 新建时没得比（本来就没有旧值），只看时间合法；编辑时没改动就别白写一次
  const canSave = startOk && (draft.id === null || changed);
  // 13.11 / v1.20：休息日与假期只作记录，不判"耽误训练"
  const restDay = (() => {
    const kind = dayTypeOf?.(date) ?? null;
    return kind === "rest" || kind === "holiday";
  })();

  return (
    <>
      <div className="muted text-[12px]">日期（补录历史、录明天都在这改）</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {(
          [
            ["今天", today],
            ["明天", addDays(today, 1)],
          ] as [string, string][]
        ).map(([label, value]) => (
          <Chip key={value} active={date === value} onClick={() => setDate(value)}>
            {label}
          </Chip>
        ))}
        <input
          className="input h-9 w-36 py-1 text-[12.5px]"
          type="date"
          aria-label="加班日期"
          value={date}
          onChange={(e) => setDate(e.target.value || today)}
        />
      </div>

      <div className="muted mt-4 text-[12px]">开始时间（判据固定 22:30，跟「提醒时间」无关）</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {OVERTIME_QUICK_TIMES.map((time) => (
          <Chip key={time} active={start === time} onClick={() => setStart(time)}>
            {time}
          </Chip>
        ))}
        <input
          className="input h-9 w-24 py-1 text-center"
          type="time"
          aria-label="开始时间"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        {startOk && !restDay && (
          <Pill tone={overtimeVerdictText(start) === "来得及" ? "ok" : "warn"}>
            {overtimeVerdictText(start)}
          </Pill>
        )}
        {startOk && restDay && <span className="muted text-[11.5px]">只记录</span>}
      </div>

      <div className="muted mt-4 text-[12px]">备注（选填）</div>
      <input
        className="input mt-1.5 h-10"
        placeholder="版本上线 / 赶项目"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {startOk && (
        <p className="muted mt-3 rounded-xl border border-border p-2.5 text-[11.5px] leading-relaxed">
          {overtimePreviewText(overtimeDateLabel(date, today), start, { restDay })}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button type="button" className="btn btn-secondary min-h-[46px] flex-1" onClick={onClose}>
          取消
        </button>
        {draft.id !== null && onDelete && (
          <button
            type="button"
            className="btn btn-secondary min-h-[46px] flex-1 text-alert"
            onClick={() => onDelete(draft)}
          >
            删除
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary min-h-[46px] flex-[1.4]"
          disabled={!canSave}
          onClick={() =>
            onSubmit({
              ...draft,
              date,
              start,
              note: note.trim() === "" ? null : note.trim(),
            })
          }
        >
          {draft.id === null ? "记下" : "保存"}
        </button>
      </div>
      <p className="muted mt-2 text-[11px]">
        {restDay ? "保存后只作记录：那天不练，不参与训练判定。" : "保存后当晚判定立刻重算，不用等到提醒那一刻。"}
      </p>
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`tap rounded-lg border px-2.5 text-[12.5px] ${
        active ? "border-accent bg-accent-soft font-semibold" : "border-border"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
