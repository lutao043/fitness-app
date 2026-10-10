# 第三方来源与开源致谢

本文件登记本项目**使用到的第三方数据与开源软件**，以及它们的许可证与义务。
新增依赖或引入外部数据时，请在这里补一行（名称 / 来源 / 许可证 / 是否改动）。

最后核对日期：2026-10-09（许可证以各自仓库当前声明为准；E2E 相关的 Playwright 依赖已移除）。

---

## 1. 动作库数据（本项目自建）

- `src/data/exercises.json` 的动作库（114 个动作）**是本项目自建的中文条目**：
  动作名、肌群标注、器械、参考起始重量、居家可做标记、器械变体，均为本项目自行整理与撰写。
- 维护约定（需求书 13.14）：动作名里不带器械；同一动作跨器械用「器械变体」表达。
- **覆盖度对照**：动作的肌群分类与动作模式覆盖面，对照了下面这份公共领域数据集做过查漏（只做对照，未复制其文本）：

| 名称 | 来源 | 许可证 | 本项目如何使用 |
|---|---|---|---|
| free-exercise-db | https://github.com/yuhonas/free-exercise-db | **Unlicense（公共领域）** | 仅作**覆盖度对照**：核对我们是否漏掉了某个肌群/动作模式的常见做法（如斜方、下背原本没有归宿）。未复制其动作名称或说明文本；若后续要引入，Unlicense 允许自由使用（无署名义务）。 |

- **刻意未使用**的数据集（避免许可证传染，特此说明）：
  - wger（https://wger.de ，代码 AGPL-3.0，动作数据 CC-BY-SA 3.0/4.0 逐条标注）
  - everkinetic/data（https://github.com/everkinetic/data ，CC-BY-SA-4.0）
  - exercisedb.io、MuscleWiki、ExRx.net：商业授权，未使用。
  这些数据集的 CC-BY-SA 条款要求署名 + 同许可分发；把它们并入本项目的动作库会带来不必要的许可约束，因此**只借鉴分类思路（分类体系不受版权保护），不复制文本数据**。将来若要引入，必须：① 单独存放并单独标注许可，不与自有数据合并成一个库；② 署名作者+来源+许可链接+改动说明。
- **不使用任何第三方动作图片/GIF**：界面里的图标都是本项目手写的内联 SVG。

## 2. 开源软件（本项目使用的技术栈）

**状态列**：`已用` = 当前 `package.json` 里装着、代码里用着；`计划` = 需求书第 9 章选型里定了、后续阶段才引入。
新增依赖请在下表补一行（名称 / 许可证 / 用途 / 状态）。

| 名称 | 许可证 | 用途 / 备注 | 状态 |
|---|---|---|---|
| Next.js | MIT | 应用框架（需求书第 9 章）；`output: standalone` | 已用 |
| React / React DOM | MIT | UI 运行时 | 已用 |
| TypeScript | Apache-2.0 | 语言 | 已用 |
| Tailwind CSS（含 `@tailwindcss/postcss`） | MIT | 样式（v4，CSS-first 配置） | 已用 |
| clsx · tailwind-merge · class-variance-authority | MIT | shadcn/ui 风格的类名合并与变体工具（组件是"复制进项目"的，这三个是它的常规搭配） | 已用 |
| Radix UI | MIT | shadcn/ui 的底层原语 | 计划（当前手写组件够用，未安装） |
| drizzle-orm / drizzle-kit | Apache-2.0 / MIT | ORM 与迁移 | 已用 |
| better-sqlite3 | MIT | SQLite 驱动；13.x 自带全平台预编译二进制（无需 node-gyp） | 已用 |
| TanStack Query | MIT | 服务端状态 | 已用 |
| React Hook Form | MIT | 表单 | 计划（MVP 的表单只有单输入框，v1.1 规则管理做表单时再引入；**已从依赖中移除**避免空依赖） |
| Recharts | MIT | 图表（体重/围度曲线、容量统计） | 计划（v1.1） |
| Serwist（`serwist` + `@serwist/next` + `@serwist/cli`，同为 MIT） | MIT | PWA / Service Worker（NFR-2）：`pnpm build:sw` 把 `src/sw.ts` 打成 `public/sw.js` 并注入预缓存清单（用 CLI 的 configurator 模式，不走它的 webpack 插件 —— 原因见 `serwist.config.mjs` 顶部注释） | 已用（devDependency：只参与构建，运行时不 import，不进镜像） |
| web-push | **MPL-2.0** | Web Push（弱 copyleft：只有修改其源文件才需回馈，调用/打包不传染） | 计划（MVP+） |
| jose | MIT | 签发会话 JWT（30 天 session cookie） | 已用 |
| @node-rs/argon2 | MIT | 密码哈希（预编译 napi 包，不需要 node-gyp 工具链；需求书第 9 章列的 node-argon2 的替代，NFR-9 登记） | 已用 |
| node-cron | ISC | 容器内定时任务（每日 03:30 备份 + 孤儿会话清理） | 已用 |
| date-fns / date-fns-tz | MIT | 日期与 `Asia/Shanghai` 时区 | 已用 |
| Vitest | MIT | 单测（排期引擎、口径库、接口） | 已用 |
| @vitest/coverage-v8 | MIT | 覆盖率观测（issue #30：`pnpm coverage`，**只观测、不设阈值、不进 CI 门禁**） | 已用（devDependency：只本地/按需跑，不进运行镜像） |
| ~~Playwright~~ | Apache-2.0 | 端到端测试 | **已移除**（改为人工回归，依赖与用例一并删除，不再登记） |
| ESLint / eslint-config-next / `@eslint/eslintrc` | MIT | 代码检查（ESLint 9 flat config + Next 规则） | 已用 |
| Prettier | MIT | 格式化 | 已用 |
| sharp | Apache-2.0 | **仅开发期**：`scripts/generate-icons.mjs` 把图标 SVG 光栅化成 PNG/ICO（`pnpm icons:generate`）。带 librsvg 与各平台预编译二进制，用它就不必再装 ImageMagick / Inkscape（NFR-9 登记） | 已用（devDependency，不进运行镜像：应用代码不 import 它） |
| Docker 官方 node 镜像 | `docker-node` 构建仓 MIT + Node.js MIT | 运行环境（Debian 基础镜像内含各自许可） | 已用（Dockerfile） |
| pnpm | MIT | 包管理器（开发机与镜像构建） | 已用 |

均为宽松许可（MIT / Apache-2.0 / ISC / MPL-2.0），**无 GPL/AGPL/SSPL 传染项**。
分发（例如将来公开仓库或发布镜像）时，保留各依赖自带的 LICENSE 即可；Apache-2.0 与 MPL-2.0 只需保留其许可证与声明，无强制的界面署名义务。

## 3. 数据来源（非动作库）

| 事项 | 说明 |
|---|---|
| 节假日/补班表 | 正式版由 AI 助手抓官方放假安排后经 `PUT /api/v1/holidays` 写入（需求书 FR-24 / 13.12），本项目不内置第三方日历数据 |
| 体重/训练/补剂等记录 | 全部是用户自己的数据，导出即用户所有（`GET /api/v1/export.json`） |

## 4. 致谢

- 感谢 [yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db)（Unlicense）把动作数据放进公共领域，本项目的肌群覆盖度对照用了它；
- 感谢上面列出的所有开源项目作者 —— 这个工具几乎每一层都站在他们的肩上；
- 动作库的中文条目、口径与规则由本项目自行整理与修正。
