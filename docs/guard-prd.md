# 权限与保密方案 PRD（组织准入 / 保密项目 / AI 问答 / 访问留痕 / 项目规则）

> 状态：**待你确认后开工**。本轮不改动会议线的 P0-c 计划，只新增五条能力（F1~F5）。
> 每节末尾的「落地位置」都是现有代码的真实切入点，实现时无需再找地方。

---

## 0. 你的批复记录（三轮问答，逐条锁定，不再自行假设）

| # | 议题 | 批复 |
|---|---|---|
| 1 | 保密项目里系统管理员（ADMIN）的权限 | **管理员照常可见，只留痕**（不受协议签署约束，但每次查看都写访问日志） |
| 2 | 保密项目额外收紧的口子 | **四项全收**：① 取消「主要关联部门负责人」的默认可见；② 保密项目进展不在首页对非成员显示；③ 保密项目暂停每日进展群发到钉钉群；④ 非成员提问时，保密项目不进入 AI 问答可答范围 |
| 3 | 未入部门新用户的拦截强度 | **只做前端缺省页**（后端不加 403 拦截）—— 残留风险见 §7 |
| 4 | AI 问答的入口与人群 | **独立「AI 问答」页**，只对 ADMIN / DEPT_LEADER 开放 |
| 5 | 保密协议文本 | **全局一份模板**，管理员后台可编辑 + **版本化**（新签署记录到具体版本号） |
| 6 | 签署形式 | **一个「我已阅读」按钮**（不做手写姓名、不做手绘签名） |
| 7 | 访问日志记录范围 | **保密项目的文档/文件查看与下载 + 进入保密项目详情**（其余一律不记） |
| 8 | 项目规则提醒 | **只发站内信**提醒未阅成员（不走钉钉私聊） |
| 9 | 规则修订后的已阅 | **不强制重新已阅**，也不做历史版本表（改正文保留原已阅记录） |
| 10 | 第 3 条「咨询中的信息」的数据范围 | 资讯（News）内容 + 知识库文档 / SOP 经验 + 会议纪要与待办条目（外加项目/任务/进展） |
| 11 | 保密开关由谁拨 | **仅系统管理员（ADMIN）** |
| 12 | 已阅触发方式 | **手动点「已阅」按钮，可附一句文字说明** |
| 13 | 新人待分配是否推送提醒管理员 | **不推送**，只在管理后台用户列表标记「未分配部门」 |

---

## F1. 新注册用户未加入部门：全站缺省页

### 现状
- `AuthService.register()` 自助注册：`departmentId` 为空、`role=MEMBER`（首个用户才是 ADMIN），注册完直接发正式 token。
- `MainLayout.vue` 的 `el-menu` 是静态的，人人可见全部菜单。
- `router/index.ts` 的 `beforeEach` 只校验「登录」与 `meta.admin`，没有任何组织归属判断。
- `usersApi.list()`（GET /users）对所有登录用户开放，未分配部门的人也能拉到全员名单。

### 方案
1. `stores/auth.ts` 新增 getter：
   `pendingOrg = loggedIn && user.role !== 'ADMIN' && !user.departmentId`
   （ADMIN 永不锁——首个管理员本就没有部门；DEPT_LEADER / PROJECT_LEADER 无部门同样锁，因为它们的权限依附于部门）
2. 新路由 `/pending` → `views/PendingView.vue`（**菜单位置保留、可正常进入**，页面内容替换为缺省提示）：
   - 文案主句：「你的账号尚未加入组织，请联系管理员为你分配部门后再使用」。
   - 展示：姓名、注册邮箱/手机号、注册时间，便于截图发给管理员；一个「刷新状态」按钮（调 `fetchMe()`，一旦 `departmentId` 非空自动跳回原页面）。
   - 不放任何业务数据。
3. `beforeEach` 增加一道闸（在现有 admin 闸之后）：`auth.pendingOrg && to.name !== 'pending' && to.name !== 'logout'` → 重定向 `/pending`；加入部门成功后 `/pending` 反而重定向首页。
   - 免闸路由：`login`、`pending`、`meta.public`（对外分享页）。
   - 「个人资料」页（`/profile`）**也一并按缺省页处理**：新人只有改密码这一件事要做，而首次登录强制改密弹窗（`mustChangePassword`）在全局拦截器里独立工作，不依赖 `/profile`，因此不豁免，行为更一致。
4. 各 View 的 `onMounted` 请求：因为路由已经跳走，组件不会挂载，天然不会发请求，**不需要逐个 View 改**。
5. 管理后台 `AdminView.vue` 用户表「部门」列：`departmentId` 为空且非 ADMIN 时，在 select 旁加红色 `el-tag`「未分配部门 · 已锁定」；列头筛选保持现状（已有 placeholder「未归属」）。

### 落地位置
`apps/web/src/stores/auth.ts`、`apps/web/src/router/index.ts`、新增 `apps/web/src/views/PendingView.vue`、`apps/web/src/views/admin/AdminView.vue`。

---

## F2. 保密项目 + 在线签署保密协议

### 数据模型
```prisma
model Project {
  confidential Boolean @default(false) // 保密项目：仅项目成员（且已签署保密协议）可见，ADMIN 可见但留痕
}

// 全局保密协议模板，版本化；表内可有 多行，每行一个版本，最大 version 为当前生效版
model NdaVersion {
  id          String   @id @default(cuid())
  version     Int      @unique
  content     String   // Markdown 协议正文
  createdById String?  // 哪个管理员改的
  createdAt   DateTime @default(now())
  signings    NdaSign[]
}

// 一人一项目一条签署记录（点「我已阅读」即落库）
model NdaSign {
  id           String   @id @default(cuid())
  projectId    String
  userId       String
  ndaVersionId String   // 签的是哪一版
  createdAt    DateTime @default(now())
  project      Project  @relation(...)
  user         User     @relation(...)
  ndaVersion   NdaVersion @relation(...)
  @@unique([projectId, userId])
}
```
- 首次上线：若 `NdaVersion` 为空，服务层自动写入一条默认模板（`version=1`，正文见 §F2.协议默认文本），无需手工初始化。
- **改模板不追签**：新版本只对「之后新签署的人」生效；已签旧版的人保持已签状态（批复 5 只要「版本化」，没要求重签；如需强制重签只要加一条 `NdaSign.requiredVersion` 判定，成本极低，留作后续开关）。

### 可见性口径（谁看得见 / 看不见）
| 身份 | 非保密项目 | 保密项目 |
|---|---|---|
| ADMIN | 全部可见 | **可见 + 可管理**，不需签署，但查看写 AccessLog（批复 1、7） |
| 项目 owner / ProjectMember 且已签 | 可见 | 可见 |
| 项目成员但**未签** | — | 列表里能看到自己所在的项目（带 🔒），**进入详情即被协议遮罩挡住**，只能先签署 |
| 主要关联部门负责人（非项目成员） | 可见（现有口径） | **不可见**（批复 2①） |
| 其他成员 | 不可见 | 不可见 |

实现方式：把 `Project.confidential` 塞进既有过滤条件的「部门负责人」那一条 OR 分支，其余分支不动 —— 这是最小改动且不会误伤既有行为的做法。

```ts
// projects.service.visFilter：只给部门负责人那条分支加门禁
{ status: ACTIVE, confidential: false, departments: { some: { department: { leaderId: userId } } } }
```
同样的 `confidential: false` 补丁要落在四处（都是各模块自己的「部门负责人默认可见」分支）：
- `projects.service.visFilter()`（列表 + 首页 `myUpdates()` 共用它 → **一次改动同时满足批复 2②**：首页绿色「进展」不再对非成员显示保密项目）
- `documents.service.visibleWhere()` 的 PROJECT/EXTERNAL 分支
- `documents.service` 项目空间准入校验里的 `isLinkedDeptLeader`（保密时置 false），且 `spaceOfFile()` 返回的 `managers` 对保密项目只留 ownerId（避免关联部门负责人能改名/删文件）
- `knowledge.service.visibleWhere()` 的 `DocVisibility.PROJECT` 分支

### 群发收紧（批复 2③）
`daily-digest.service.runGroupTick()` 的查询条件加 `confidential: false` —— 保密项目不再每日群发进展到钉钉群。
**私聊汇总不动**（`buildDigest` 那条链路保持现状），因为你收得到自己参与的项目的内容，这不属于对外泄露；若要一并停，改同一函数即可，我会在项目设置文案里写清楚两者区别。

### 签署交互
1. ADMIN 在「项目设置」抽屉（现有 `ProjectDetailView.openSettings`）里新增开关：**保密项目**（仅 ADMIN 可见该开关）。
   - 关闭开关时弹二次确认：「关闭后该项目对所有可见成员放开，已签署记录保留」。
   - 接口独立：`PUT /projects/:id/confidential { confidential }`，`@Roles(ADMIN)`；现有 `PATCH /projects/:id` 一律**忽略** body 里的 `confidential`，防止绕过。
2. 开启后：项目详情接口返回 `nda = { required, signed, version, content }`。
   - `required && !signed` → 前端整页遮罩：协议正文（MarkdownView）+ 底部「我已阅读」按钮 → `POST /projects/:id/nda-sign` → 成功后刷新详情。
   - 非成员直接访问详情：沿用现有 404/403 文案「项目不存在或无权限」，**不暴露「这是个保密项目」**。
3. 项目列表卡片：`confidential` 显示 `el-tag` 🔒 保密；成员未签时卡片右上角点「待签署保密协议」。
4. 站内信：项目被设为保密后，给全部项目成员（除 ADMIN）发一条 `NotificationType.ANNOUNCEMENT`，link=`/projects/:id`，标题「《X》已设为保密项目，请阅读并确认保密协议」。仅这一次，不重复催（与批复 13 的「不主动推送」口径一致）。

### 协议默认文本（version=1 初稿，你可后台直接改）
标题「项目保密协议」，五段：① 保密信息范围（项目内容/任务/文档/数据/进展/群聊摘要）② 保密义务（不外传、不向未授权成员透露、离职后仍有效）③ 期限（持续至该项目解除保密为止）④ 违约责任（停止权限、依公司制度追责）⑤ 确认条款（点击「我已阅读」即视为已阅读并同意，系统留存账号、时间、协议版本）。

### 落地位置
`apps/api/prisma/schema.prisma`、`projects.service/controller`、`documents.service`、`knowledge.service`、`daily-digest.service`、`apps/web/src/views/ProjectDetailView.vue`、`ProjectList(ProjectsView.vue)`、`apps/web/src/api/index.ts`。

---

## F3. AI 问答（对话式取数）

### 定位
只读问答：管理员/部门负责人用一句话问出项目情况、流程（SOP）、资料、资讯、会议纪要。写入仍走已有的首页录入（`IntakeService`）。

### 数据源与权限（关键：上下文按提问人自己的权限装）
新增 `AskContextService`，按提问人 `me` 组装候选上下文，**所有检索都复用各模块现成的可见性函数**，于是自动满足批复 2④：非项目成员（含 DEPT_LEADER）拿不到保密项目的任何字段，也就不会被喂给模型。

| 数据源 | 取什么 | 权限口径 |
|---|---|---|
| 项目 | `visFilter()` 结果内项目：名称/负责人/状态/起止/完成度/健康度/成员 | 复用 `projects.service.list()` 的过滤 |
| 进展 | `ProjectUpdate` 最近 N 条（含钉钉群 AI 总结） | 随项目可见性 |
| 任务 | 项目下任务标题/状态/负责人/截止（每项目最多 30 条） | 随项目可见性 |
| SOP | `status=CONFIRMED` 的经验条目 title/content/tags | 全员可见，按关键词筛 |
| 知识库文档 | `KnowledgeDoc` 标题 + 正文摘要（可见性 `visibleWhere()`，正文截断 1200 字/篇，最多 8 篇） | 复用现有过滤 |
| 资讯 | `NewsItem`（团队源 + 提问人个人订阅源）标题/AI 摘要/来源 | 现有 news 可见口径 |
| 会议 | `Meeting` 标题/时间/状态 + `MeetingItem` 条目与完成情况 | 参与者、主持人或 ADMIN |
单次上下文预算：拼好后总长超 `ASK_MAX_CHARS`（默认 24000 字，env 可调）就按上表优先级从低到高裁，**先裁资讯/SOP，最后才裁项目与任务**。

### 调用与提示词
- `AiService.generate('admin.ask', { question, history, context, today })`，在 `prompts/PROMPTS.md` 新增块 `name: admin.ask`：要求「只用给定资料回答；资料没有就明确说不知道并指出该去哪个页面看；结论后用 `[来源: 项目/文档/资讯/SOP/会议 + 名称]` 标注；不要编造数字；中文」。
- 每次调用**自动落 `AiCallLog`**（现成机制），因此问答内容天然是可审计的——这一条也顺手满足了「提问留痕」，无需新表。
- 多轮：前端本地存 history（最多带最近 6 轮），后端不落会话表（批复里没要求存档成会话列表）。

### 前端
- 新页 `/ask` → `AiAskView.vue`：左侧问题列表（内置快捷问题：「本周各项目风险」「X 流程怎么走」「昨天群里聊了什么」「我的部门周报情况」），右侧气泡对话，回答里的 `[来源: …]` 渲染成可点击标签跳到对应页面；顶部提示「回答由 AI 依据你有权查看的数据生成，可能不完整」。
- 菜单加「AI 问答」项（`MainLayout.vue`），`meta.roles: ['ADMIN','DEPT_LEADER']`，在 `beforeEach` 里按 `roleRank >= 2` 判定，不够就跳首页（现有只支持 `meta.admin`，扩展成 `meta.minRole`）。

### 落地位置
新增 `apps/api/src/modules/ask/{ask.controller.ts,ask.service.ts,ask-context.service.ts,ask.module.ts}`、`prompts/PROMPTS.md`、`app.module.ts`、新增 `apps/web/src/views/AiAskView.vue`、`MainLayout.vue`、`router/index.ts`、`api/index.ts`。

---

## F4. 保密访问留痕

只记批复 7 勾选的三类事件，其他不记（日志量可控，也避免「什么都记等于没记」）。

```prisma
model AccessLog {
  id        String   @id @default(cuid())
  createdAt DateTime // 北京墙钟字面量（同 AiCallLog 口径，展示不做时区换算）
  userId    String
  userName  String   // 冗余快照：人员改名/删除后日志仍可读
  action    String   // ENTER 进入详情 / VIEW 打开预览 / DOWNLOAD 下载
  resType   String   // PROJECT 项目详情 / DOCFILE 上传文件 / KNOWLEDGE_DOC 知识库文档
  resId     String
  resName   String   // 冗余快照：资源名（改名/删除后仍可追溯）
  projectId String?  // 所属项目（便于按项目聚合）
  ip        String?
  userAgent String?
  @@index([projectId, createdAt])
  @@index([userId, createdAt])
}
```
写入点（**只在资源所属项目 `confidential=true` 时写**，非保密项目一律不写）：
1. `projects.get(id, userId, role)`（`GET /projects/:id` 的实现）—— 任何人（含 ADMIN）进入保密项目详情记一条 `ENTER`。
2. `GET /documents/files/:id/content`（controller 的 `content()`，预览与下载的唯一出口，`sendFile` 之前埋点，因为这里才拿得到 `inline` 标记）—— `?inline=1` 记 `VIEW`（浏览器内预览），不带 inline 记 `DOWNLOAD`（走 `Content-Disposition: attachment`）。
3. `knowledge.getDoc(id, user)`（`GET /knowledge/:id`）—— 若该文档 `projectId` 对应保密项目，记 `VIEW`。
写入方式：`void this.log(...).catch(()=>{})` 异步不阻塞主流程（与 `AiCallLog` 一致）；IP 取 `x-forwarded-for` 首段（Caddy 已透传），UA 截断 200 字。

查询与展示：`GET /access-logs?projectId=&userId=&date=&page=`（`@Roles(ADMIN)`），AdminView 新增标签页「保密访问日志」：日期选择 + 项目/人员筛选 + 表格（时间、谁、动作、资源、所属项目、IP）+ 「今天 N 人次查看保密项目」概览条。日志只有 ADMIN 可查，本人不可查自己的（避免暴露项目存在性）。保留期：暂不设自动清理，后续如需在 `daily` scheduler 挂一条删除 >N 天的记录（默认 365 天）。

---

## F5. 项目规则 + 已阅

### 模型
```prisma
model ProjectRule {
  id          String   @id @default(cuid())
  projectId   String
  title       String
  content     String   // Markdown 正文（可多条规则，按发布时间倒序展示）
  createdById String
  publishedAt DateTime @default(now())
  updatedAt   DateTime?
  acks        ProjectRuleAck[]
  @@index([projectId, publishedAt])
}

// 已阅回执：手动点按钮，可附一句说明
model ProjectRuleAck {
  id        String   @id @default(cuid())
  ruleId    String
  userId    String
  note      String?  // 可选文字说明
  createdAt DateTime @default(now())
  @@unique([ruleId, userId])
}
```

### 权限与交互
- **发布/修改/删除**：项目管理员 = `ADMIN` 或 `ProjectMember.role=OWNER`（即项目负责人）。与批复一致：不是任意成员都能改。
- **查看**：该项目下所有成员均可看（现有项目文档链路的成员口径）。
- `ProjectDetailView.vue` 页头下方新增卡片「项目规则」：正文 Markdown、发布人 + 发布时间、已阅进度条（`12/15 已阅`）、名单折叠展示（已阅 / 未阅两栏，未阅显示姓名便于催办）；有权限的人多两个按钮「＋ 发布规则」「编辑」，弹窗里正文 + 标题。
- 成员侧：一个「我已阅」按钮 + 一个可选的一句话输入框；点完立即变「已阅 · 你的说明」，不可撤回（防止刷数据）。
- 发布后：站内信（`NotificationType.ANNOUNCEMENT`，link=`/projects/:id`，标题「《项目名》新规则：{title}」）发给**该项目全部成员中尚未已阅的人**（排除发布人自己）；这是异步 `Promise.allSettled`，失败不影响发布成功（与会议通知同一写法）。
- 编辑正文：只更新 `updatedAt`，**不清空已阅**（批复 9）。

### 落地位置
`schema.prisma`、`projects.service/controller`（规则 CRUD + ack + 站内信）、`apps/web/src/views/ProjectDetailView.vue`、`api/index.ts`。

---

## 6. 上线批次（每批一次 `prisma db push` + 一次部署，可独立验收）

| 批次 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **G1** | F1 未入部门缺省页（纯前端 + AdminView 标记） | 无表改动 | 最小，先上 |
| **G2** | F2 保密项目 + F4 留痕（含 `NdaVersion/NdaSign/AccessLog` 三张表、四处可见性补丁、群发收紧、日志查询页） | db push | 最大块，两者必须同批（保密与留痕是一件事） |
| **G3** | F5 项目规则 + 已阅（`ProjectRule/ProjectRuleAck`） | db push | 中 |
| **G4** | F3 AI 问答（`admin.ask` 提示词 + ask 模块 + `/ask` 页） | 无表改动 | 中，放最后（要调提示词、需要多轮实测） |

会议线 **P0-c（周会周期位与自动生成）** 尚未开工；我建议顺序 G1 → G2 → G3 → 回 P0-c → G4，理由：G2 的可见性补丁会影响 P0-c 里「项目会议」的可见范围，先把门禁定了再做会议自动生成，省一次返工。**你要是不想等，我也可以把 G4 插到 P0-c 前面，说一声即可。**

## 7. 已知残留风险（你选了「只前端缺省页」，我必须写明白）
1. **F1 只是看不见的门，不是取不到的门**：未分配部门的用户仍可直接调 `GET /users`、`GET /projects` 等接口拿到 JSON（例如浏览器 devtools 手动请求）。`visFilter` 决定了项目类接口拿不到别人的项目，但 `/users`（全员名单）会如实返回。想真正封住，需要在 `JwtAuthGuard` 后加一道 `OrgGuard`（对 `role!=ADMIN && !departmentId` 只放行 `users/me`、`auth/*`、`notifications/*`），约 30 行代码、随时可补，我在 G1 里先不做，等你一句话。
2. **保密项目的钉钉群侧仍留痕**：项目若绑定了钉钉群，AI 进展总结的原始群消息在 `MessageInbox` 里是全量的（抓取链路不因保密而停），只是不再群发。彻底停抓取 = 解绑群，我没自动做。
3. 「修改协议模板不追签」按批复 5 的字面理解实现（只版本化、不强制重签）。若你其实想要「改了就全部重签」，改一个判定条件即可，说一声。

## 8. 验收清单（每批上线后逐项看）
- G1：用一个无部门的 MEMBER 账号登录 → 菜单可点但内容全是缺省页 → 管理员分配部门 → 刷新状态即恢复；AdminView 该用户显示「未分配部门 · 已锁定」。
- G2：ADMIN 把某项目设为保密 → 非成员（含关联部门负责人）列表与首页进展都看不到该项目；成员看到 🔒 但被协议遮罩挡住，点「我已阅读」后正常；当日 20:00 该项目不再向钉钉群群发；ADMIN 打开该项目的文件后，「保密访问日志」里出现 VIEW/DOWNLOAD 记录。
- G3：负责人发布一条规则 → 成员在详情页看到规则 + 「我已阅」；站内信到达未阅成员；点已阅后名单实时变化。
- G4：ADMIN 问「最近哪些项目有风险」「X 流程怎么操作」→ 回答带 `[来源]`；DEPT_LEADER 问保密项目内容 → 回答里没有该项目（并明说看不到）；`/ai-calls` 页能看到每次问答的完整提示词与回答。
