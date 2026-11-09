# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app
# 固定 pnpm 版本与本地一致（v11+ 的 allowBuilds 语法不兼容 pnpm 10 lockfile 生态）
ENV NPM_CONFIG_REGISTRY=https://mirrors.tencentyun.com/npm
RUN npm install -g pnpm@10.34.4
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter web
COPY apps/web apps/web
RUN pnpm --filter web build

# ---- 运行阶段：nginx 托管静态资源 ----
FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# SPA 路由回退（/projects/:id 直达/刷新不 404）；构建上下文为仓库根，路径含 apps/web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
