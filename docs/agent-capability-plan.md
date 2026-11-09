# 小助手能力扩展方案（PBC 填报状态 + 管理视角取数）

| 项 | 内容 |
| --- | --- |
| 状态 | **待确认，未开发** |
| 日期 | 2026-11-08 |
| 触发 | 用户问「11 月 PBC 谁没填」，小助手回复「系统里没有 PBC 填报数据源」 |
| 结论 | 属实：小助手 20 个只读工具里没有 PBC；但 PBC 后端接口齐全，**只需接工具，不改数据库** |
| 影响模块 | `apps/api/src/modules/agent`、`prompts/PROMPTS.md`、`apps/web/src/components/ManagerAgentChat.vue`、`AgentWelcome.vue` |

---

## 1. 一句话现状

小助手能查「项目、日报、周报、任务、会议、工时榜、知识库」，**唯独查不到 PBC**——因为 PBC 是后加的模块，没进 Agent 工具清单。所以你问 11 月谁没填，它只能如实说没有数据源。

| 你现在想让它回答的 | 现在 | 原因 |
| --- | --- | --- |
| 11 月 PBC 谁还没填 / 各填了多少 | ❌ | 无 PBC 工具 |
| 我 11 月 PBC 填了吗、还差哪步 | ❌ | 同上 |
| 待我审核的 PBC 有几个人 | ❌ | 同上 |
| 11 月 PBC 排行 / 上个月排行 | ❌（只有首页卡片能看） | 同上 |
| 谁本周周报没交 | ✅ | `weekly_status` |
| 今天谁日报没交 | ✅ | `daily_status` |
| 项目进展 / 风险 / 任务逾期 | ✅ | `project_progress` / `project_risks` / `project_tasks` / `overdue_tasks` |
| 项目里有哪些文件、某人日报写了什么 | ✅ | `project_files` / `project_reports` |
| 工时榜 / 日报榜 / 我的排名 | ✅ | `team_ranking` / `my_ranking` |
| 建任务、催办、发群、开会、写日报 | ✅（确认卡后执行） | 14 类动作 |

---

## 2. 现有能力全清单（20 只读 + 14 动作）

档位说明：**全员**＝普通成员也能用；**管理**＝仅管理员 / 部门负责人 / 项目负责人档。

### 2.1 项目域（7）

| 工具 | 能回答什么 | 档位 |
| --- | --- | --- |
| `list_projects` | 我能看到哪些项目、各有多少任务、什么状态 | 全员 |
| `project_progress` | 某项目最近 14 天进展 | 管理 |
| `project_risks` | 某项目健康度 / 风险 / 建议 | 管理 |
| `project_tasks` | 某项目任务统计、逾期与进行中明细 | 管理 |
| `project_weekly` | 某项目周报已交/缺交/正文摘录 | 管理 |
| `project_files` | 项目文件清单 + 在线文档标题 | 全员（按项目收敛） |
| `read_project_doc` | 读项目在线文档全文 / 文件元数据 | 全员（按项目收敛） |
| `project_reports` | 项目成员最近 N 天日报正文 | 全员（按项目收敛） |

### 2.2 人与状态（5）

| 工具 | 能回答什么 | 档位 |
| --- | --- | --- |
| `weekly_status` | 本周周报应交/已交/缺交名单 | 管理 |
| `daily_status` | 某项目今日日报谁已交/谁待补 | 管理 |
| `overdue_tasks` | 跨项目逾期任务清单（谁/项目/逾期天数） | 管理 |
| `team_ranking` | 团队工时榜、日报篇数榜 | 管理 |
| `my_ranking` | 我自己的名次（只回本人） | 全员 |

### 2.3 个人（4）

| 工具 | 能回答什么 | 档位 |
| --- | --- | --- |
| `my_today` | 我今天的写作素材（完成/推进的任务、本周日报摘要） | 全员 |
| `my_tasks` | 我的待办（含逾期天数） | 全员 |
| `my_work_schedule` | 我这周的排班（哪天要写日报） | 全员 |
| `list_meetings` | 我要参加的会 / 某项目会议 | 全员 |

### 2.4 知识与群（3）

| 工具 | 能回答什么 | 档位 |
| --- | --- | --- |
| `search_knowledge` | 公司知识库检索（按权限过滤） | 全员 |
| `search_sop` | SOP 经验库检索 | 全员 |
| `group_options` | 可发到的钉钉群名 | 管理 |

### 2.5 动作（14，均先出确认卡）

`MEETING_CREATE`、`MEETING_PUBLISH`、`MEETING_NOTIFY`、`WEEKLY_SEND_GROUP`、`WEEKLY_CHASE`、`TASK_CREATE`、`TASK_PATCH`、`OVERDUE_CHASE`、`NOTIFY_BROADCAST`、`DAILY_SUBMIT`、`WEEKLY_SUBMIT`、`WORK_SCHEDULE_SET`、`DAILY_CHASE`、`RISK_ALERT`

普通成员档只能用其中 4 个：`TASK_PATCH`（只能改自己的）、`DAILY_SUBMIT`、`WEEKLY_SUBMIT`、`WORK_SCHEDULE_SET`。

---

## 3. 缺口排序（按项目经理 / 老板的真实日常）

| 优先级 | 缺口 | 典型问法 | 现状 |
| --- | --- | --- | --- |
| **P0** | PBC 填报与考核 | 「11 月 PBC 谁没填」「我自评交了吗」「待我审核几个」 | 完全没有 |
| P1 | 立项待办 | 「有几个项目等我审批」 | 只能自己去项目页看 |
| P1 | 里程碑/排期延期 | 「哪些项目快到期了、哪些里程碑延期」 | 只能看详情页 |
| P1 | 成员负载 | 「谁手上活最多 / 谁这周没排班」 | 无 |
| P2 | 连续未交 | 「谁连续三周没交周报」 | 只能按单周查 |
| P2 | 公告已读 | 「公告还有谁没看」 | 无 |
| P2 | NDA 缺口 | 「保密项目还有谁没签协议」 | 无 |
| P2 | 复盘/SOP | 「这个月复盘交了几份、哪些 SOP 待确认」 | 无 |
| P2 | 库存/资源预定 | 「设备还剩几台、会议室明天几点空」 | 无 |

---

## 4. P0 方案：PBC 四件套 + 催填

### 4.1 `my_pbc`（全员）

**args**：`{ "month"?: "YYYY-MM" }`（缺省当月）

**返回**：
```json
{
  "month": "2026-11",
  "planStatus": "APPROVED",          // DRAFT/SUBMITTED/REJECTED/APPROVED
  "reviewStatus": "NOT_STARTED",     // NOT_STARTED/SELF_DONE/LEADER_DONE
  "selfTotal": null, "leaderTotal": null,
  "pbcLeaderName": "孙敏惠",
  "nextAction": "计划已通过，自评随时可提交（原定 11-28 开放，现已不限时）",
  "items": 4
}
```
只回本人，普通成员档可用。

### 4.2 `pbc_status`（管理）

**args**：`{ "month"?: "YYYY-MM", "departmentName"?: "部门名" }`

**返回**：
```json
{
  "month": "2026-11",
  "summary": { "expected": 35, "noRecord": 12, "draft": 0, "submitted": 2, "rejected": 5, "approved": 16, "selfDone": 0, "finalized": 0 },
  "byDepartment": [{ "department": "研究生", "expected": 9, "filled": 9, "missing": 0 }],
  "missing": [{ "name": "周航", "department": "研究生", "status": "REJECTED", "leader": "孙敏惠", "daysLate": 8 }],
  "note": "「无记录」= 本月还没建 PBC；「被驳回」= 计划被打回需重提"
}
```

**口径**（必须写进提示词，避免模型瞎算）：
- 应填人口 = 上个月有 PBC 的人 ∪ 本月已有记录的人（无法从组织架构判定谁「必须填」，用连续性推断）
- `noRecord` 与 `REJECTED` 合并为「还没填好」，回答时分开说
- 已定稿（`LEADER_DONE`）不计入未填

### 4.3 `pbc_review_queue`（管理）

**args**：`{ "month"?: "YYYY-MM" }` → 复用 `GET /pbc/review-queue`：待我评分人数、每人自评合计与提交时间、逾期天数。

### 4.4 `pbc_ranking`（管理）

**args**：`{ "month"?: "YYYY-MM", "top"?: 10 }` → 复用 `ranking` / `latest-ranking`：最终得分、自评分、领导调整；**只返回已定稿的人**。

### 4.5 动作 `PBC_CHASE`（管理）

给未填人员发钉钉私聊 + 站内信催填。

- **args**：`{ "month"?: "YYYY-MM", "departmentName"?: "部门名", "names"?: ["张三"] }`
- 名单**由系统重扫**，模型不得自己编；发送前再算一次
- 每人每天最多 1 条（复用 `lastReportRemindAt` 式频控，单独字段或内存表）
- 默认**只私聊 + 站内信**，不发群（PBC 涉及个人考核，不进群）
- 消息里带直达链接：`/reports?tab=pbc&view=self`

### 4.6 权限矩阵

| 角色 | `my_pbc` | `pbc_status` | `pbc_review_queue` | `pbc_ranking` | `PBC_CHASE` |
| --- | --- | --- | --- | --- | --- |
| MEMBER | ✅ 仅自己 | ❌ | ❌ | ❌（只给自己名次可用 `my_pbc` 带出） | ❌ |
| PROJECT_LEADER | ✅ | ❌（不含部门管理权时） | ✅ 仅「我是打分上级」的人 | ✅ | ✅ 仅自己负责审核的人 |
| DEPT_LEADER | ✅ | ✅ 本部门 | ✅ | ✅ | ✅ 本部门 |
| ADMIN | ✅ | ✅ 全公司 | ✅ | ✅ | ✅ |

**红线**：分数（`selfTotal`/`leaderTotal`/逐条分）只对**本人、其打分上级、ADMIN** 可见；`pbc_status` 对部门负责人只回「填没填」，不回分数。

---

## 5. P1 / P2 建议（一次做完还是分批，你定）

| 优先级 | 建议工具 | 回答什么问题 | 数据来源 | 权限 |
| --- | --- | --- | --- | --- |
| P1 | `project_approvals` | 有几个立项等我审批、卡了几天 | `Project.status=PENDING` + 审批人 | 管理 |
| P1 | `project_milestones` | 哪些里程碑/排期延期、本周该交付什么 | `ProjectMilestone` / `ProjectScheduleItem` | 管理 |
| P1 | `team_workload` | 每人当前在手任务数、逾期数、本周工时（谁超载/谁空闲） | Task + Report 工时 | 管理 |
| P2 | `weekly_streak` | 谁连续 N 周没交周报 | Report 按周聚合 | 管理 |
| P2 | `announcement_status` | 最新公告谁没读 | Announcement + 已读表 | 管理 |
| P2 | `nda_status` | 保密项目还有谁没签 NDA | NDA 签署表 | 管理 |
| P2 | `retro_status` / `sop_pending` | 本月复盘提交率、待确认 SOP | `ProjectRetro` / `Sop` | 管理 |
| P2 | `inventory_status` / `resource_bookings` | 设备库存、会议室/资源占用 | `Inventory` / `ResourceBooking` | 管理 |

> 这些都不需要改数据库，都是「已有接口/表 + 包一层工具」。

---

## 6. 还要改的提示词规则（关键，不然模型会乱说）

在 `prompts/PROMPTS.md` 增补 4 条硬约束：

1. **PBC 有三种「没填」**：无记录、计划被驳回、计划待审批——回答必须分开说，不能笼统说「没填」。
2. **只报状态不报分**：除非用户是本人或该人的打分上级，否则不输出任何分数。
3. **查 ≠ 催**：问「谁没填」只查；只有明说「催/提醒」才出 `PBC_CHASE`，且名单必须来自工具实测。
4. **月份口径**：不指定月份时用**当月**；回答里必须带上「2026 年 11 月」字样，避免跨月误读。

---

## 7. 改动面

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 后端 | `apps/api/src/modules/agent/agent.service.ts` | 新增 4 个只读工具 + 1 个动作；`MEMBER_TOOLS` 加 `my_pbc`；`runTool` 分发；`buildAction` 加 `PBC_CHASE` |
| 后端 | `apps/api/src/modules/agent/agent.controller.ts` | 新增 `POST /agent/pbc-chase`（管理者档二次校验 + 重扫） |
| 后端 | `apps/api/src/modules/agent/agent.module.ts` | 引入 `PbcModule`（复用 PBC 的可见性/队列/排行逻辑，不重写） |
| 提示词 | `prompts/PROMPTS.md` | 工具清单 + 4 条约束 + 快捷问 |
| 前端 | `components/ManagerAgentChat.vue` | `PBC_CHASE` 确认卡渲染与执行调用；工具名中文标签 |
| 前端 | `components/AgentWelcome.vue` | 管理档快捷问加「11 月 PBC 谁没填」 |
| 文档 | `docs/PRD.md` | AI 能力清单同步 |
| 数据库 | — | **无迁移** |

---

## 8. 验收用例

1. 管理员问「11 月 PBC 谁没填」→ 返回按部门分组的名单，明确区分「无记录 / 被驳回 / 待审批」，数字与工作管理 → PBC 团队表一致。
2. 普通成员问「我 11 月 PBC 填了吗」→ 只回自己的状态与下一步，不出现任何他人信息。
3. 部门负责人问「我们部门 PBC 填得怎么样」→ 只回本部门，且不含分数。
4. 打分上级问「待我审核几个」→ 与「工作管理 → PBC → 待我审核」人数一致。
5. 说「催一下没填的人」→ 出确认卡（人数 + 名单 + 只私聊），确认后发送，重扫后已填的人自动剔除。
6. 问「谁没填」但没说催 → **不得**自动发送（查 ≠ 催）。

---

## 9. 需要你拍板 5 件事

| # | 问题 | 我的建议 |
| --- | --- | --- |
| 1 | PBC 状态给谁看？项目负责人能看自己项目成员「填没填」但不含分数，还是只看部门？ | 按部门口径（与工作管理 → PBC 团队表一致），项目负责人只看自己 |
| 2 | 部门负责人能否看到下属 PBC 具体分数？ | 不能，只能看填没填；分数仅本人 + 打分上级 + ADMIN |
| 3 | PBC 催填只私聊，还是也发项目群？ | 只私聊 + 站内信（考核数据不进群） |
| 4 | 不指定月份时默认当月还是上月？ | 当月（11 月问就是 11 月） |
| 5 | P1 的 3 个（立项待办 / 里程碑延期 / 成员负载）这轮一起做吗？ | 建议一起做，同一套工具框架，边际成本低 |

---

## 10. 附：11 月 PBC 现状（人工核对，供你参考）

| 状态 | 人数 |
| --- | ---: |
| 有 11 月记录 | 23 |
| 计划已通过 | 16 |
| 计划待审批 | 2 |
| 计划被驳回（需重提） | 5 |
| 10 月有填、11 月无记录 | 21 |
| 全站启用账号 | 106 |

> 注意：「应填人口」不能简单取 106（含大量不填 PBC 的成员）。建议按「上月有记录 ∪ 本月有记录」推断，否则名单会多出 60 多人。
