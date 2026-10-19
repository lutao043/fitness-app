# fitness-app｜健身助手

自托管的个人健身 Web App：**排期 + 训练记录 + 提醒 + 进度可视化**。
单用户使用，数据都在自己的 SQLite 文件里；Docker 单容器部署，手机浏览器打开即用。

## 功能

- **今日与排期**：按分化方案（默认四天循环）算出「今天练什么」；假期 / 补班表、加班顺延、加练与休日加班；练前热身提示
- **训练记录**：逐组记录（重量 + 次数）、组间歇倒计时、每组感受、暂停 / 提前结束；训练中可换器械变体、换动作、调整本次清单；补明细、有氧记录、一键打卡
- **身体与进度**：体重 / 围度记录与曲线、趋势解读、目标进度、统计与 7 天漏练图、连续记录
- **提醒**：提醒判定与「到点该发的提醒」列表（`GET /api/v1/reminders/due`），可以交给外部脚本 / 助手按任意渠道投递
- **自托管**：单用户登录、SQLite（WAL）+ 每日自动备份、CSV 导出、PWA 外壳（离线打开）
- **外部 API**：`/api/v1/*`（Bearer token），方便脚本或 AI 助手读写数据

## 技术栈

Next.js 15（App Router, standalone）· TypeScript · SQLite（better-sqlite3, WAL）· Drizzle ORM · Tailwind CSS · Serwist（PWA）· Vitest

## 快速开始

```bash
# 需要 Node 22（见 .nvmrc）与 pnpm
pnpm install
cp .env.example .env        # 填 SESSION_SECRET：openssl rand -base64 32
pnpm dev                    # http://localhost:3210 → 首次打开会引导设置密码
```

数据落在 `./data/fitness.sqlite`；删掉它并重启就是全新安装。
`pnpm check` 是质量门禁（typecheck + lint + 549 个单测）。

## 部署

Docker 单容器（`node:22-slim` 的 standalone 产物；非 root、端口 3210、数据挂 `./data`、容器启动时自动执行数据库迁移）：

```bash
docker compose up -d --build
```

环境变量见 `.env.example`：`SESSION_SECRET` 必填；`API_TOKEN` 可选，供外部助手调 `/api/v1/*`。

## 说明

- 单测覆盖排期引擎（102 天逐日基线对拍）、提醒判定与主要接口；不引入 E2E，界面回归靠手工。
- 第三方依赖与数据的许可证清单见 `THIRD-PARTY-NOTICES.md`（动作库为本项目自建条目，只对照公共领域数据集做过查漏，不使用任何第三方图片）。

## 许可证

见 `LICENSE`（源码公开可见，保留所有权利）。
