/**
 * 时间与跨零点归属单测（需求书 13.3 / NFR-7）。
 */

import { describe, expect, it } from "vitest";
import {
  addDays,
  dateInTz,
  dayDiff,
  formatCn,
  hhmmToMinutes,
  isValidDateStr,
  isValidTimeStr,
  minutesToHhmm,
  timeInTz,
  weekdayCn,
  isWeekend,
} from "@/lib/time";

describe("Asia/Shanghai 时区换算（NFR-7）", () => {
  it("23:40（上海）开始 → 归属当天，不归到第二天", () => {
    // 2026-09-25 23:40 +08:00 = 2026-09-25T15:40Z
    expect(dateInTz(new Date("2026-09-25T15:40:00Z"))).toBe("2026-09-25");
    expect(timeInTz(new Date("2026-09-25T15:40:00Z"))).toBe("23:40");
  });

  it("00:20（上海）结束 → 已经是新的一天（13.3）", () => {
    // 2026-09-25T16:20Z = 2026-09-26 00:20 上海
    expect(dateInTz(new Date("2026-09-25T16:20:00Z"))).toBe("2026-09-26");
    expect(timeInTz(new Date("2026-09-25T16:20:00Z"))).toBe("00:20");
  });

  it("UTC 16:00 整是上海的次日 0 点（跨日边界）", () => {
    expect(dateInTz(new Date("2026-09-25T15:59:59Z"))).toBe("2026-09-25");
    expect(dateInTz(new Date("2026-09-25T16:00:00Z"))).toBe("2026-09-26");
  });
});

describe("纯日历运算", () => {
  it("addDays 跨月 / 跨年 / 闰年", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // 闰年
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 平年
  });

  it("dayDiff 给出整数天差", () => {
    expect(dayDiff("2026-09-21", "2026-09-28")).toBe(7);
    expect(dayDiff("2026-09-28", "2026-09-21")).toBe(-7);
    expect(dayDiff("2026-09-21", "2026-09-21")).toBe(0);
  });

  it("星期与中文格式化", () => {
    expect(weekdayCn("2026-09-21")).toBe("周一");
    expect(weekdayCn("2026-09-26")).toBe("周六");
    expect(weekdayCn("2026-10-10")).toBe("周六");
    expect(isWeekend("2026-10-10")).toBe(true);
    expect(formatCn("2026-09-25")).toBe("9月25日 周五");
    expect(formatCn("2026-01-01")).toBe("1月1日 周四");
  });

  it("日期 / 时刻字符串校验（挡掉格式对但日子不存在的）", () => {
    expect(isValidDateStr("2026-09-28")).toBe(true);
    expect(isValidDateStr("2026-02-30")).toBe(false);
    expect(isValidDateStr("2026-9-8")).toBe(false);
    expect(isValidDateStr("2026-13-01")).toBe(false);
    expect(isValidTimeStr("22:30")).toBe(true);
    expect(isValidTimeStr("24:00")).toBe(false);
    expect(isValidTimeStr("22:60")).toBe(false);
  });

  it("HH:mm ↔ 分钟（加班判据 22:30 = 1350 分钟）", () => {
    expect(hhmmToMinutes("22:30")).toBe(1350);
    expect(minutesToHhmm(1350)).toBe("22:30");
    expect(minutesToHhmm(-30)).toBe("23:30"); // 跨零点回绕
    expect(minutesToHhmm(1440)).toBe("00:00");
  });
});
