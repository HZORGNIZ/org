# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app
# 固定 pnpm 版本与本地一致（v11+ 的 allowBuilds 语法不兼容 pnpm 10 lockfile 生态）
ENV NPM_CONFIG_REGISTRY=https://mirrors.tencentyun.com/npm
RUN npm install -g pnpm@10.34.4
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter api
COPY apps/api apps/api
RUN pnpm --filter api db:generate && pnpm --filter api build

# ---- 运行阶段 ----
FROM node:22-alpine
# gcompat: 宿主机 dws CLI（dingtalk-workspace-cli）的 vendor/dws 是 glibc ELF，
# alpine 默认 musl 无 /lib64/ld-linux-x86-64.so.2，缺它 exec 报 ENOENT
RUN apk add --no-cache gcompat libstdc++
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/node_modules node_modules
# pnpm isolated 布局：包级符号链接位于 apps/api/node_modules（指向 /app/node_modules/.pnpm）
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY prompts prompts
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
