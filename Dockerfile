# 自托管健身 Web App（需求书 NFR-1：Docker 单容器、node:22-slim standalone、非 root、TZ=Asia/Shanghai）
#
# 构建：docker build -t fitness-app:latest .
# 运行：见 docker-compose.yml（端口 3210、数据挂 ./data、restart: unless-stopped）

FROM node:22-slim AS base
# corepack 下载 pnpm 本身也走国内源（构建环境访问不了 npmjs）
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    TZ=Asia/Shanghai \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app

# ——— 依赖（利用缓存层）———
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ——— 构建 ———
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ——— 运行（最小镜像）———
FROM node:22-slim AS runner
# 版本信息可由构建参数注入（--build-arg），本地构建默认 dev；
# 烧进 OCI label 与 /app/VERSION，线上看镜像属性或容器内文件就知道跑的哪一版
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILD_DATE=unknown
LABEL org.opencontainers.image.title="fitness-app" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.created="${APP_BUILD_DATE}"
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3210 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/drizzle \
    APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${APP_COMMIT} \
    APP_BUILD_DATE=${APP_BUILD_DATE}
WORKDIR /app

# 非 root 运行（node 镜像自带 uid 1000 的 node 用户）
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 迁移文件要进镜像：容器启动时 drizzle migrate 会读它
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

RUN mkdir -p /app/data && chown -R node:node /app/data && \
    printf 'version=%s\ncommit=%s\nbuilt=%s\n' "$APP_VERSION" "$APP_COMMIT" "$APP_BUILD_DATE" > /app/VERSION && \
    chown node:node /app/VERSION
USER node
EXPOSE 3210

# 健康检查：首页拿得到 200（未登录会被 middleware 302 到 /login，也算活着）
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
