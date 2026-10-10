/**
 * 有氧（爬坡走）的口径常量（FR-50 / v1.16）。
 *
 * 只记分钟数：形式固定「爬坡走」，坡度与速度不记（3.6 不做精算，也不换算卡路里）。
 * 范围 1~600 分钟是**读数范围校验**（与 13.1 的读数校验同源）：出界是脏数据，不是"留空"。
 * 放进 lib 而不是路由文件里：Next 的 route 模块只允许导出路由处理器与 config。
 * 范围数字本身在 `./ranges`（唯一真相，issue #28）。
 */

import { CARDIO_MINUTES } from "./ranges";
export const CARDIO_MIN_MINUTES = CARDIO_MINUTES.min;
export const CARDIO_MAX_MINUTES = CARDIO_MINUTES.max;

/** 有氧的展示名（形式固定，不做选择；需求书 3.6 只接受爬坡走） */
export const CARDIO_LABEL = "爬坡走";
