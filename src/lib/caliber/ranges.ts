/**
 * 记录类字段的取值范围（**唯一真相**，issue #28）。
 *
 * 以前同一批数字有三份：`server/rules.ts`（服务端兜底）、页面里的硬编码（就地拦住）、提示文案里的字面。
 * 改一处漏一处就变成"页面放行、接口拒绝"（用户看到莫名其妙的报错）或反过来"页面拦得比接口严"（数据进不来）。
 *
 * 放 `src/lib/**` 而不是 `server/**`：页面（客户端组件）要直接引它，而 `src/lib` 是纯逻辑层、
 * 不依赖 React / Next / DB（lint 强制）—— 客户端引它不会把服务端代码打进包里。
 * `server/rules.ts` 从这里 re-export，接口层与页面**引用的是同一个对象**。
 */

/** 记一组的读数：**0 合法**（试举失败 / 没上重量 / 提前收工都不算错，13.1） */
export const SET_WEIGHT_KG = { min: 0, max: 400 } as const;

/** 体重：0 不算一次称重（判据是 `> min`，13.2）；上限 400 */
export const BODY_WEIGHT_KG = { min: 0, max: 400 } as const;

/** 体脂率 %：0~75（13.2 v1.26 / issue #10 R1） */
export const BODY_FAT_PCT = { min: 0, max: 75 } as const;

/** 次数（与计时动作的秒数同档）：整数 0~999（13.1 / 13.19） */
export const REPS_RANGE = { min: 0, max: 999 } as const;

/** 有氧分钟数：1~600（FR-50 / 13.4） */
export const CARDIO_MINUTES = { min: 1, max: 600 } as const;

/** 动作级组间歇（秒）：10~600（FR-52） */
export const REST_SEC = { min: 10, max: 600 } as const;

/** 杠重 kg：0~50（13.1；EZ 杆 10、美制杠 45 lb ≈ 20.4） */
export const BAR_KG = { min: 0, max: 50 } as const;
