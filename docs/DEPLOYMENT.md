# MyOrgNiz 部署与运维手册

> 本文档描述**生产环境**的真实状态，不是设想。
> 所有结论来自三处交叉验证：项目内配置文件、`.local/` 下的历史部署脚本、以及对服务器的实测（2026-11-08 校验通过）。
> 涉及登录凭据时只写文件名与位置，不写密钥内容。

---

## 0. 一页速查

| 项 | 值 |
| --- | --- |
| 生产域名 | **https://hzai.work**（`www.hzai.work` 301 到主域名） |
| 服务器公网 IP | **124.223.100.121**（腾讯云 CVM） |
| SSH 登录用户 | **root** |
| SSH 私钥 | 仓库根目录 `202609yangli-tencent腾讯云.pem` |
| SSH 端口 | 22（默认） |
| 服务器系统 | OpenCloudOS（`hostname` = `VM-0-10-opencloudos`） |
| 代码部署目录 | **`/srv/myorgniz`** |
| 编排方式 | Docker Compose，project name = `myorgniz` |
| 对外端口 | 80 / 443（仅 Caddy 暴露，其余服务走容器内网） |
| 数据库备份目录 | `/srv/backups/`（`pg_dump` 压缩存盘） |
| 磁盘 | 40G，已用 71%（2026-11-08） |
| 数据库管理 | postgres 超级用户 `myorgniz` / 库 `myorgniz`，容器 `myorgniz-postgres-1` |

一条命令验活：

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://hzai.work/        # 期望 200
curl -sk -o /dev/null -w '%{http_code}\n' https://hzai.work/api/agent/config  # 期望 200 或 401
```

---

## 1. 这些信息从哪来（可复核）

| 信息 | 来源 |
| --- | --- |
| IP、域名、密钥文件名 | `AGENTS.md`（项目根，随仓库走） |
| 域名兜底基址、钉钉链接前缀 | `.env.example` 里的 `APP_WEB_BASE_URL`、`MEETING_SITE_URL` 默认值 `https://hzai.work` |
| 登录用户、部署路径、容器名 | `.local/deploy*.sh`（179 个历史批次脚本，编号已到 176）与 `.local/check*.ps1` |
| 生产反代规则 | 服务器上的 `/srv/myorgniz/deploy/Caddyfile`（**注意与仓库内同名文件不同**，见 §7） |
| 容器与端口 | 服务器实测 `docker compose ps` + 仓库 `docker-compose.yml` |
| 服务器专属挂载 | 服务器上的 `/srv/myorgniz/docker-compose.override.yml`（不在仓库里） |

**一处需要更正的旧说法**：`AGENTS.md` 写「登录用户名可能是 ubuntu」，实测是 **root**。历史脚本全部使用 `root@124.223.100.121`，用 ubuntu 登录会失败。

---

## 2. 架构拓扑

```
                    Internet
                       │  80 / 443
              ┌────────▼─────────┐
              │  caddy:2-alpine  │  自动申请/续期 TLS（hzai.work）
              │  请求体上限 512MB │
              └───┬──────────┬───┘
        /api/*    │          │  其它路径
        ┌─────────▼──┐   ┌───▼────────────┐
        │ api:3000   │   │ web:80 (nginx) │  Vue3 SPA + PWA
        │ NestJS     │   │ 静态资源        │
        └──┬──┬──┬───┘   └────────────────┘
           │  │  │
   ┌───────▼┐ │ ┌▼──────────────┐
   │postgres│ │ │ redis:6379    │  BullMQ 队列（提醒/抓取/推送）
   │pgvector│ │ └───────────────┘
   │  :5432 │ │
   └────────┘ │
        ┌─────▼──────────┐
        │ minio :9000    │  对象存储（控制台 :9001，未对外）
        └────────────────┘
```

- 只有 `caddy` 声明了 `ports`，api / web / postgres / redis / minio 全部在 compose 内网互通，公网不可直连。
- api 容器把 `/app/apps/api/logs` 挂到宿主 `./logs/api`，AI 提示词日志（`ai-prompts-YYYY-MM-DD.log`）可直接在宿主机查看。
- api 容器额外挂了宿主机 Node 全局包目录与 `dws` CLI 登录态，用于「以用户身份」抓取钉钉群消息（见 §7）。

### 2.1 容器清单（2026-11-08 实测）

| 容器 | 镜像 | 作用 |
| --- | --- | --- |
| `myorgniz-caddy-1` | `caddy:2-alpine` | 唯一入口、TLS、反向代理 |
| `myorgniz-api-1` | 本地构建 `myorgniz-api` | NestJS 后端，3000 |
| `myorgniz-web-1` | 本地构建 `myorgniz-web` | nginx 托管前端静态文件 |
| `myorgniz-postgres-1` | `pgvector/pgvector:pg16` | 主库（含向量扩展，知识库检索用） |
| `myorgniz-redis-1` | `redis:7-alpine` | 队列与会话缓存 |
| `myorgniz-minio-1` | `minio/minio:latest` | 文件对象存储 |

---

## 3. 技术栈与运行时

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 + Vite 6 + Element Plus 2.9 + Pinia + vue-router，`vite-plugin-pwa` 支持安装到桌面/手机 |
| 后端 | NestJS 11 + Prisma 6 + Passport-JWT + BullMQ 6 |
| 数据库 | PostgreSQL 16 + pgvector |
| 对象存储 | MinIO（S3 兼容） |
| AI | OpenAI 兼容协议，默认 DeepSeek（`deepseek-chat`），经 `ai`/`@ai-sdk/openai-compatible` 调用 |
| 钉钉 | `dingtalk-stream`（群消息订阅）+ `dws` CLI（用户身份拉群消息）+ 自定义机器人推送 |
| 镜像基础 | `node:22-alpine` 构建，运行阶段 api 用 node:22-alpine，web 用 `nginx:alpine` |
| 包管理 | pnpm **10.34.4**（Dockerfile 内固定版本，勿随意升级：pnpm 11 的 `allowBuilds` 语法与现有 lockfile 不兼容） |

---

## 4. 环境变量（`/srv/myorgniz/.env`）

生产 `.env` 只存在于服务器，**不进 Git**。字段清单见仓库 `.env.example`，按用途分组：

| 分组 | 关键变量 | 说明 |
| --- | --- | --- |
| 应用 | `PORT` `NODE_ENV` `WEB_ORIGIN` | `WEB_ORIGIN` 用于 CORS 与 PWA，生产应为 `https://hzai.work` |
| 数据库 | `DATABASE_URL` | 生产主机名是 compose 服务名 `postgres`，不是 localhost |
| 队列 | `REDIS_URL` | 同上，用服务名 `redis` |
| 认证 | `JWT_SECRET` `JWT_EXPIRES_IN` | **必须为长随机串**，泄露等价于全站账号被接管 |
| 存储 | `MINIO_*` | `MINIO_ENDPOINT` 生产写服务名 `minio`，`MINIO_USE_SSL=false`（内网） |
| AI | `AI_BASE_URL` `AI_API_KEY` `AI_MODEL` `AI_TIMEOUT_MS` | 换模型只改这里，提示词在 `prompts/PROMPTS.md` |
| 站外链接 | `APP_WEB_BASE_URL` `MEETING_SITE_URL` | 钉钉消息里的可点击链接前缀，**换域名只改这两处** |
| 钉钉 | `DINGTALK_ENABLED` `DINGTALK_CLIENT_ID/SECRET` `DINGTALK_GROUPS` `DINGTALK_PUSH_GROUPS` | 不配则整块能力关闭 |
| 定时抓取 | `DINGTALK_FETCH_ENABLED` `DINGTALK_FETCH_CRON` `DINGTALK_FETCH_CRON_NIGHT` `DINGTALK_DWS_JS` | 默认北京时间 12/17/19 点 + 22 点夜间批 |
| 每日总结 | `DINGTALK_DIGEST_ENABLED` `DINGTALK_DIGEST_CRON` `DINGTALK_DIGEST_TO` `DINGTALK_DIGEST_EXCLUDE` `DINGTALK_DIGEST_MOTTO_DEFAULT` | 默认 20:00 私聊汇总 + 各项目群 |
| AI 日志外发 | `DINGTALK_AI_LOG_ENABLED` `DINGTALK_AI_LOG_CRON` | 默认每天 8 点把前一日提示词日志私聊给 `DINGTALK_DIGEST_TO` |
| 会议提醒 | `MEETING_REMINDER_ENABLED` `MEETING_REMINDER_TICK_CRON` `MEETING_REMINDER_DAILY_CRON` | tick 每 5 分钟；20:00–07:00 为禁发窗口（开始提醒豁免） |
| Web Push | `VAPID_PUBLIC_KEY` `VAPID_PRIVATE_KEY` `WEB_PUSH_CONTACT` | 不配则只走站内信与钉钉 |
| 数据保留 | `MESSAGE_RETENTION_DAYS` | 默认 180。**注意：当前代码未读取该变量**，群消息清理任务尚未实现，改它不会生效——表会一直长 |

改完 `.env` 需要重建容器才生效：`docker compose up -d api`（`env_file` 在容器启动时读取）。

---

## 5. 标准发布流程

历史批次脚本（`.local/deploy176.sh` 为最新一版范例）固化了同一套流程，**照抄结构、只换批次号**。

### 5.1 本地打包

1. 列出本次改动文件清单（精确到文件，不做全量打包，减少传输与误覆盖）。
2. 打 tar.gz + 生成 MD5 清单。
3. **MD5 文件必须用 LF 换行**，否则服务器 `md5sum -c` 全部报错。PowerShell 里用 `[IO.File]::WriteAllText` 拼 `\n`。
4. **脚本必须 ASCII-only**：PowerShell + scp 会破坏非 ASCII 载荷，中文路径/中文注释容易变乱码。

参考 `.local/pack-deploy100.ps1`：`tar -czf .local/deployN-src.tar.gz @files` + `Get-FileHash -Algorithm MD5`。

### 5.2 上传并执行

```bash
PEM="202609yangli-tencent腾讯云.pem"
scp -i "$PEM" .local/deployN-src.tar.gz .local/deployN-md5.txt .local/deployN.sh root@124.223.100.121:/tmp/
ssh -i "$PEM" root@124.223.100.121 'bash /tmp/deployN.sh'
```

### 5.3 服务器端脚本骨架（推荐顺序）

```bash
set -e
cd /srv/myorgniz

# 1) 解包 + 校验，校验失败立即中止
tar -xzf /tmp/deployN-src.tar.gz
md5sum -c --quiet /tmp/deployN-md5.txt

# 2) 结构自检（可选但推荐）：断言改动确实落地，失败则什么都别建
python3 /tmp/assertN.py

# 3) 数据库备份（有 schema 变更时必做）
mkdir -p /srv/backups
docker exec myorgniz-postgres-1 pg_dump -U myorgniz -d myorgniz \
  | gzip -9 > "/srv/backups/myorgniz_preN_$(date +%Y%m%d_%H%M%S).sql.gz"

# 4) 构建（构建失败则不切换，旧容器继续服务）
docker compose build api && docker compose build web

# 5) 切换 + 启动
docker compose up -d api web

# 6) 探活（轮询到 200/401 为止，别用固定 sleep）
curl -sk -o /dev/null -w '%{http_code}\n' https://hzai.work/api/agent/config
```

**关键设计**：先校验、再备份、再构建、最后切换。任一环节失败就停在原地，旧镜像继续跑，不产生半上线状态。

### 5.4 数据库结构变更

项目**不使用 `prisma migrate`**，走 `prisma db push`：

```bash
ssh -i "$PEM" root@124.223.100.121 'cd /srv/myorgniz && docker compose exec -T api npx prisma db push'
```

- `db push` 只做增量同步，**破坏性变更（删列/改类型）不会提示，直接执行**。
- 因此 schema 有改动时：**先 `pg_dump` 备份，再 push**，顺序不能反。
- 纯前后端代码变更（无 schema）跳过此步——历史脚本注释里会显式写 `NO schema change -> no db push`。

### 5.5 回滚

```bash
# 代码回滚：重新打包上一版源码，走一遍 §5.2
# 数据回滚：停 api，恢复备份，再起
docker compose stop api
gunzip -c /srv/backups/myorgniz_preN_<时间戳>.sql.gz \
  | docker exec -i myorgniz-postgres-1 psql -U myorgniz -d myorgniz
docker compose start api
```

镜像层回滚不可靠（`docker compose up -d` 会重建 tag 相同的镜像），**回滚以代码为单位**。

---

## 6. 常用运维命令

```bash
PEM="202609yangli-tencent腾讯云.pem"
SSH='ssh -i '"$PEM"' root@124.223.100.121'

# 容器状态
$SSH 'cd /srv/myorgniz && docker compose ps'

# 后端日志（近 10 分钟的错误）
$SSH 'docker logs myorgniz-api-1 --since 10m 2>&1 | grep -aE "ERROR|Exception" | head -20'
$SSH 'docker logs -f myorgniz-api-1'

# 反代日志（看 502/证书问题）
$SSH 'docker logs myorgniz-caddy-1 --since 30m 2>&1 | tail -50'

# 数据库交互
$SSH 'docker exec -it myorgniz-postgres-1 psql -U myorgniz -d myorgniz'

# 表体积 / 行数速查
$SSH 'docker exec myorgniz-postgres-1 psql -U myorgniz -d myorgniz -Atc "select relname,n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 20;"'

# AI 提示词日志（宿主机直接看）
$SSH 'ls -lh /srv/myorgniz/logs/api/ | tail -5'
$SSH 'tail -50 /srv/myorgniz/logs/api/ai-prompts-$(date +%F).log'

# 备份现状
$SSH 'ls -lh /srv/backups/ | tail -10'

# 磁盘
$SSH 'df -h /srv; docker system df'
```

### 6.1 证书

Caddy 自动申请与续期，证书落在 `caddydata` 卷里。域名解析正常的前提下无需人工干预。若续期失败，先查 80/443 是否被其它进程占用（`ss -lntp | grep -E ':80|:443'`）。

---

## 7. 三个容易踩的坑（已踩过，写在服务器上）

### 7.1 仓库内 `deploy/Caddyfile` ≠ 生产配置

| | 仓库内文件 | 服务器文件 |
| --- | --- | --- |
| 站点 | `:80`（开发/内网模式） | `hzai.work { ... }` + `www.hzai.work` 重定向 |
| HTTPS | 注释掉，示例用 `example.com` | 自动签发，已生效 |
| 用途 | 本地 compose 起步用 | 真实生产 |

**发布时不要用仓库内的 Caddyfile 覆盖服务器上的那份**，否则 HTTPS 立刻失效、站点降级为 HTTP。若确需修改反代规则，先 `cp /srv/myorgniz/deploy/Caddyfile /srv/myorgniz/deploy/Caddyfile.bak` 再改，改完 `docker compose restart caddy`。

### 7.2 web 容器 502：nginx entrypoint 卡死

`nginx:alpine` 自带的 `10-listen-on-ipv6-by-default.sh` 会在 `apk manifest nginx` 处挂起（拉软件源索引超时），导致 nginx 永不启动、Caddy 返回 502。项目自带 `default.conf` 且不使用 templates，因此服务器上 `docker-compose.override.yml` 直接跳过全部 entrypoint 脚本：

```yaml
services:
  web:
    entrypoint: ["nginx"]
    command: ["-g", "daemon off;"]
```

**这个 override 只存在于服务器，不在仓库里**。换机重建时必须手工补上，否则 502。

### 7.3 钉钉群消息抓取依赖宿主机 CLI

`DingtalkFetchService` 以**用户身份**（非应用身份）拉群消息，依赖宿主机的 `dws` CLI 与 root 登录态。override 里挂了三个只读/状态目录：

```yaml
services:
  api:
    volumes:
      - /opt/nodejs/lib/node_modules:/opt/nodejs/lib/node_modules:ro
      - /root/.dws:/root/.dws
      - /root/.local/share/dws-cli:/root/.local/share/dws-cli
```

同时 api 运行镜像装 `gcompat libstdc++`：`dws` 的 vendor 二进制是 glibc ELF，alpine 默认 musl 缺 `/lib64/ld-linux-x86-64.so.2`，不装就 `ENOENT`。

登录态过期时，抓取任务会失败但不影响主站。重新登录需在服务器上执行 `dws login`，之后 `docker compose restart api`。

---

## 8. 定时任务（都在 api 进程内，BullMQ + cron）

| 任务 | 默认时间（北京时间） | 开关变量 |
| --- | --- | --- |
| 钉钉群消息抓取 | 12:00 / 17:00 / 19:00 | `DINGTALK_FETCH_ENABLED` |
| 夜间补充抓取 | 22:00 | 同上 |
| 每日团队进展总结（私聊 + 各项目群） | 20:00 | `DINGTALK_DIGEST_ENABLED` |
| AI 提示词日志外发 | 08:00 | `DINGTALK_AI_LOG_ENABLED` |
| 会议到点扫描（开始提醒 + 材料催办） | 每 5 分钟 | `MEETING_REMINDER_ENABLED` |
| 周会待发布提醒 | 08:00 | 同上 |
| 任务/日报到期提醒 | 队列驱动 | 无独立开关 |

时区不是靠容器 `TZ` 兜底，而是每个队列 `add(..., { pattern, tz: 'Asia/Shanghai' })` 显式指定，避免 BullMQ 按 UTC 解释导致偏 8 小时。**新增队列务必照样带上 `tz`**。改 cron 后需重启 api。

---

## 9. 安全底线

1. **私钥与 `.env` 永不进 Git**：`.gitignore` 已排除 `.env`，但 `.pem` 在仓库根目录，对外分享仓库前务必移除。私钥权限本地应收紧为 `600`。
2. **`JWT_SECRET` 必须足够长且随机**，且各环境不同。轮换会导致全员重新登录，属可接受代价。
3. **数据库与 MinIO 仍是默认弱口令**（`myorgniz/myorgniz123`、`minioadmin/minioadmin`）。当前靠「不对外暴露端口」兜底，一旦需要外部访问必须先改口令。
4. **SSH 建议改为密钥-only 并禁用 root 密码登录**；当前直接 root 登录，密钥泄露即整机沦陷。至少应限制安全组来源 IP。
5. **备份要异地**：`/srv/backups/` 与数据库同盘，磁盘故障会同时丢。建议定期拉到本地或对象存储。
6. 发布会改动 `prisma db push` 前，**备份是唯一退路**，不要跳步。

---

## 10. 换机重建清单（灾难恢复）

1. 新机装 Docker + Docker Compose（Compose V2）。
2. 建 `/srv/myorgniz`，上传源码（含 `apps/`、`prompts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`docker-compose.yml`）。
3. **手工补 `docker-compose.override.yml`**（§7.2 + §7.3 两段），否则 web 502、钉钉抓取失效。
4. 写入生产 `.env`（从旧机拷或按 `.env.example` 重建，务必换新的 `JWT_SECRET`）。
5. **用生产版 Caddyfile 覆盖**（§7.1），不要用仓库里的 `:80` 版本。
6. 域名 A 记录指向新 IP，等待解析生效。
7. `docker compose up -d`，然后 `npx prisma db push` 建表，或从备份恢复数据。
8. 恢复数据后核对：`Project`、`User`、`DocumentFile`、`Meeting` 行数。
9. 按 §0 的探活命令验证，再验证一次钉钉推送（管理后台 → 推送与统计 → 测试推送）。
