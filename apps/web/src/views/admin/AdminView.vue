<template>
  <div class="page">
    <div class="page-title">管理后台</div>

    <!-- 大 tab：十几个功能卡不再一页平铺，按用途分五组，点 tab 直接切到对应区块 -->
    <el-tabs v-model="tab" class="adm-tabs" @tab-change="onTabChange">
      <el-tab-pane label="成员与组织" name="org">

    <!-- 用户管理 -->
    <div class="page-card">
      <div class="page-title sub">
        用户管理
        <el-button type="primary" size="small" @click="showCreateUser = true">新增用户</el-button>
      </div>
      <el-table :data="users" v-loading="loadingUsers" size="small" class="table">
        <el-table-column prop="name" label="姓名" min-width="100" sortable>
          <template #default="{ row }">
            <div class="user-cell">
              <el-avatar :size="24" :src="row.avatar || undefined">{{ row.name?.slice(0, 1) }}</el-avatar>
              <!-- 人名可点：进成员画像（项目/任务/工时/会议成长轨迹） -->
              <a class="name-link" title="查看成员画像" @click="$router.push('/members/' + row.id)">{{ row.name }}</a>
            </div>
          </template>
        </el-table-column>
        <!-- 帐号信息（工号/用户名/邮箱/手机号）统一排到列表右侧，左侧只留管理动作相关的列 -->
        <el-table-column label="角色" width="120" sortable :sort-method="sortUserRole">
          <template #default="{ row }">
            <el-select
              :model-value="row.role"
              size="small"
              @change="(v: string) => setRole(row, v)"
            >
              <el-option label="管理员" value="ADMIN" />
              <el-option label="部门负责人" value="DEPT_LEADER" />
              <el-option label="项目负责人" value="PROJECT_LEADER" />
              <el-option label="成员" value="MEMBER" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="部门" width="240" sortable :sort-method="sortUserDept" :filters="deptFilters" :filter-method="filterUserDept" filter-placement="bottom-start">
          <template #default="{ row }">
            <el-select
              :model-value="row.departmentId || ''"
              size="small"
              clearable
              placeholder="未归属"
              @change="(v: string) => setUserDept(row, v || null)"
            >
              <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
            </el-select>
            <!-- 一人可属多部门：下拉是主部门，其下把额外部门排成 tag（不重复主部门） -->
            <div v-if="extraDepts(row).length" class="dept-tags">
              <el-tag
                v-for="d in extraDepts(row)"
                :key="d.id"
                size="small"
                type="info"
                effect="plain"
                class="dept-tag"
                @click="$router.push('/departments?id=' + d.id)"
                >+{{ d.name }}</el-tag
              >
            </div>
            <!-- 自助注册但尚未分配部门：前端已锁到等待页，后端 OrgGuard 也已拦住业务接口，此处提醒管理员尽快处理 -->
            <el-tooltip
              v-if="isPendingOrg(row)"
              content="该成员尚未加入组织，登录后只能看到等待页；为其选择部门后立即恢复全部功能"
              placement="top"
            >
              <el-tag size="small" type="danger" effect="plain" class="pending-tag">未分配·已锁定</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="汇报给" width="150">
          <template #default="{ row }">
            <el-select
              :model-value="row.reportsToId || ''"
              size="small"
              clearable
              filterable
              :placeholder="row.defaultReportsToName ? '默认：' + row.defaultReportsToName : '未设置'"
              @change="(v: string) => setUserReportsTo(row, v || null)"
            >
              <el-option v-for="u in reporteeOptions(row)" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" sortable :sort-method="sortUserActive">
          <template #default="{ row }">
            <el-switch
              :model-value="row.active"
              @change="(v: any) => setActive(row, v)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="注册时间" width="110" sortable>
          <template #default="{ row }">{{ fmt(row.createdAt, 'YYYY-MM-DD') }}</template>
        </el-table-column>
        <el-table-column prop="employeeNo" label="工号" width="88" sortable>
          <template #default="{ row }">{{ row.employeeNo ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="username" label="用户名" min-width="90" sortable>
          <template #default="{ row }">{{ row.username || '—' }}</template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="160" sortable />
        <el-table-column prop="phone" label="手机号" width="110">
          <template #default="{ row }">{{ row.phone || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="success"
              :disabled="row.id === auth.user?.id || !row.active"
              @click="previewUser(row)"
            >
              预览
            </el-button>
            <el-button size="small" text type="primary" @click="openEditUser(row)">编辑</el-button>
            <el-button
              size="small"
              text
              type="danger"
              :disabled="row.id === auth.user?.id"
              @click="removeUser(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 岗位清单 -->
    <div class="page-card">
      <div class="page-title sub">岗位清单（项目成员可选岗位）</div>
      <div class="pos-row">
        <el-tag
          v-for="p in positions"
          :key="p"
          closable
          class="pos-tag"
          @close="removePosition(p)"
        >
          {{ p }}
        </el-tag>
        <el-input
          v-model="newPosition"
          size="small"
          placeholder="新增岗位"
          class="pos-input"
          @keyup.enter="addPosition"
        >
          <template #append>
            <el-button @click="addPosition">添加</el-button>
          </template>
        </el-input>
      </div>
      <div class="muted digest-tip">岗位用于项目成员的具体分工标注（如产品经理、工程师、运维），增删后自动保存。</div>
    </div>

      </el-tab-pane>

      <!-- 部门管理（原侧边菜单「部门」内迁到这里）：部门表格（新增/编辑/负责人/排序/删除）+ 部门详情页（项目/成员/文档/文件/日报规则/汇报树） -->
      <el-tab-pane label="部门管理" name="departments" lazy>
      <!-- lazy：部门详情页会拉成员/项目/文档/文件/汇报树多组接口，不必在打开管理后台时就预加载 -->
    <div class="page-card">
      <div class="page-title sub">
        部门管理
        <el-button type="primary" size="small" @click="openCreateDept">新增部门</el-button>
      </div>
      <el-table :data="departments" v-loading="loadingDepts" size="small" class="table">
        <el-table-column prop="name" label="部门名称" min-width="140" />
        <el-table-column prop="description" label="描述" min-width="160">
          <template #default="{ row }">{{ row.description || '—' }}</template>
        </el-table-column>
        <el-table-column label="负责人" width="160">
          <template #default="{ row }">
            <el-select
              :model-value="row.leaderId || ''"
              size="small"
              clearable
              placeholder="未设置"
              @change="(v: string) => setDeptLeader(row, v || null)"
            >
              <el-option v-for="u in leaderOptions(row)" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="共管人" width="240">
          <template #default="{ row }">
            <!-- 大部门一个负责人管不过来：共管人与负责人同权限、管整个部门（入选自动升 DEPT_LEADER） -->
            <el-select
              :model-value="row.managerIds || []"
              size="small"
              multiple
              collapse-tags
              collapse-tags-tooltip
              clearable
              filterable
              placeholder="未设置"
              @change="(v: string[]) => setDeptManagers(row, v)"
            >
              <el-option
                v-for="u in leaderOptions(row).filter((x: any) => x.id !== row.leaderId)"
                :key="u.id"
                :label="u.name"
                :value="u.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="项目数" width="80">
          <template #default="{ row }">{{ row._count?.projectLinks ?? row._count?.projects ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="成员数" width="80">
          <template #default="{ row }">{{ row._count?.members ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="排序" width="100">
          <template #default="{ row }">
            <el-input-number :model-value="row.sortOrder" size="small" :min="0" controls-position="right" @change="(v: any) => updateDeptSort(row, v)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEditDept(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="removeDept(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 部门详情：内嵌部门页（项目/成员/文档/文件/日报规则/汇报树），隐藏其自身页头文字，只保留顶部的部门切换 -->
    <DepartmentView embedded />
      </el-tab-pane>

      <el-tab-pane label="审批与集成" name="approve">

    <!-- 文档审批（文件设为「全员可见」后需管理员通过才生效） -->
    <div class="page-card">
      <div class="page-title sub">
        文档审批
        <el-tag v-if="apPending" size="small" type="warning" effect="plain">{{ apPending }} 个待审批</el-tag>
        <el-button size="small" @click="loadApprovals">刷新</el-button>
      </div>
      <div class="ap-toolbar">
        <el-radio-group v-model="apStatus" size="small" @change="loadApprovals">
          <el-radio-button value="PENDING">待审批</el-radio-button>
          <el-radio-button value="APPROVED">已同意</el-radio-button>
          <el-radio-button value="REJECTED">已驳回</el-radio-button>
        </el-radio-group>
        <span class="muted ap-tip">通过后文件对所有人可见（包括未授权部门/项目）；驳回后降为仅上传者可见</span>
      </div>
      <el-table :data="apFiles" v-loading="apLoading" size="small" class="table" empty-text="没有需要审批的全员可见申请">
        <el-table-column label="文件" min-width="220">
          <template #default="{ row }">
            <div class="ap-name">
              <span class="ellipsis">{{ row.name }}</span>
              <el-tag v-if="row.version > 1" size="small" type="info" effect="plain">v{{ row.version }}</el-tag>
            </div>
            <div v-if="row.note" class="muted ap-note">备注：{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column label="所属空间" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="row.project ? 'primary' : 'success'" effect="plain">
              {{ row.project ? '项目' : '部门' }}
            </el-tag>
            <span class="ap-space ellipsis">{{ row.project?.name || row.department?.name || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="申请人" width="120">
          <template #default="{ row }">
            <div>{{ row.uploader?.name || '—' }}</div>
            <div class="muted ap-note">{{ row.uploader?.department?.name || '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="86">
          <template #default="{ row }">{{ formatBytes(row.size) }}</template>
        </el-table-column>
        <el-table-column label="提交时间" width="118">
          <template #default="{ row }">{{ fmt(row.updatedAt, 'MM-DD HH:mm') }}</template>
        </el-table-column>
        <el-table-column label="审批人" width="120">
          <template #default="{ row }">
            <span v-if="row.reviewedBy">{{ row.reviewedBy.name }}</span>
            <span v-else class="muted">—</span>
            <div v-if="row.reviewNote" class="muted ap-note" :title="row.reviewNote">{{ row.reviewNote }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="196" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="approvalPreview(row)">预览</el-button>
            <el-button size="small" text type="primary" @click="approvalDownload(row)">下载</el-button>
            <template v-if="row.approval === 'PENDING'">
              <el-button size="small" text type="success" @click="approveFile(row)">同意</el-button>
              <el-button size="small" text type="danger" @click="rejectFile(row)">驳回</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 集成状态 -->
    <div class="page-card">
      <div class="page-title sub">集成状态</div>
      <div class="integ-grid">
        <div v-for="s in integration.messageSources || []" :key="s.type" class="integ-card">
          <div class="integ-name">{{ s.name }}</div>
          <el-tag :type="s.connected ? 'success' : 'info'" size="small">
            {{ s.connected ? '已连接' : '未连接' }}
          </el-tag>
          <div class="muted">{{ s.detail || s.type }}</div>
        </div>
        <div class="integ-card">
          <div class="integ-name">AI 服务</div>
          <el-tag :type="integration.ai?.enabled ? 'success' : 'info'" size="small">
            {{ integration.ai?.enabled ? '已启用' : '未配置' }}
          </el-tag>
          <div class="muted">{{ integration.ai?.provider || '—' }}</div>
        </div>
      </div>
    </div>

      </el-tab-pane>

      <el-tab-pane label="进展与首页" name="digest">

    <!-- 每日团队进展推送 -->
    <div class="page-card">
      <div class="page-title sub">每日团队进展私聊汇总（发送时间）</div>
      <div class="digest-row">
        <span>每天</span>
        <el-time-select
          v-model="digestTime"
          start="00:00"
          step="00:05"
          end="23:55"
          placeholder="选择时间"
          class="digest-time"
        />
        <el-button type="primary" size="small" :loading="savingDigest" @click="saveDigestTime">保存</el-button>
        <span v-if="digestInfo?.time" class="muted">
          当前：{{ digestInfo.time }}（北京时间）<template v-if="digestInfo?.next">，下次发送：{{ digestInfo.next }}</template>
        </span>
      </div>
      <div class="muted digest-tip">
        每天按此时间将全部项目的最近进展总结私聊发给负责人（如杨力）。发到各项目群的进展总结已改为“按项目单独设置”：在项目详情页右上角「项目设置」里自定义发送时间、频率，或“立即发送到群”。修改保存后立即生效。
        <template v-if="digestInfo?.source === 'env'">当前为系统默认时间（未在后台设置过）。</template>
      </div>
    </div>

    <!-- 首页项目进展展示条数 -->
    <div class="page-card">
      <div class="page-title sub">首页项目进展展示</div>
      <div class="digest-row">
        <span>每个项目展示最近</span>
        <el-input-number v-model="homeCount" :min="0" :max="10" size="small" />
        <span>条进展</span>
        <el-button type="primary" size="small" :loading="savingHome" @click="saveHomeCount">保存</el-button>
      </div>
      <div class="muted digest-tip">
        首页每个项目卡片展示的进展条目数量（0~10，0 表示不展示进展条目）。修改保存后立即生效。项目卡片上的完成度/健康度百分比由 AI 分析产出。
      </div>
    </div>

      </el-tab-pane>

      <el-tab-pane label="AI 与助手" name="ai">

    <!-- AI 调用日志（DeepSeek） -->
    <div class="page-card">
      <div class="page-title sub">AI 调用日志（DeepSeek）</div>
      <div class="digest-row">
        <el-switch
          :model-value="aiLogInfo?.enabled"
          :loading="savingAiLogEnabled"
          @change="(v: any) => toggleAiLogEnabled(!!v)"
        />
        <span>每天自动发送</span>
        <el-button type="primary" size="small" :loading="sendingAiLog" @click="sendAiLogNow">
          立即发送前一天日志
        </el-button>
        <span v-if="aiLogInfo?.enabled && aiLogInfo?.next" class="muted">
          下次自动发送：{{ aiLogInfo.next }}
        </span>
      </div>
      <div class="muted digest-tip">
        每天 {{ aiLogTimeLabel }}（北京时间）把前一天的 DeepSeek 调用日志文件（logs/ai-prompts-YYYY-MM-DD.log）私聊发给负责人；「立即发送」不受开关限制，随时可发前一天日志。
        <template v-if="aiLogInfo?.source === 'env'">当前为系统默认配置（未在后台设置过）。</template>
      </div>
    </div>

    <!-- 小助手 Agent 悬浮窗总闸 + 员工档（与 AI 日志同属助手能力，移到 AI tab） -->
    <div class="page-card">
      <div class="page-title sub">小助手悬浮窗</div>
      <div class="digest-row">
        <el-switch
          :model-value="agentInfo?.enabled"
          :loading="savingAgentEnabled"
          @change="(v: any) => toggleAgentEnabled(!!v)"
        />
        <span>开启小助手（管理者档）</span>
      </div>
      <div class="digest-row">
        <el-switch
          :model-value="agentInfo?.memberEnabled !== false"
          :loading="savingAgentEnabled"
          :disabled="!agentInfo?.enabled"
          @change="(v: any) => toggleAgentMemberEnabled(!!v)"
        />
        <span>普通员工也可用（员工档，只查自己）</span>
      </div>
      <div class="muted digest-tip">
        管理者档：管理员/部门负责人/项目负责人能查项目进度/风险/周报，确认后代发会议/通知/催办/下发任务。员工档：普通员工只能问自己相关的待办/进度、查知识库与 SOP、口述自己的日报周报，不能催别人、不能发群。两个开关保存后立即生效；关掉总闸对所有角色隐藏入口。
      </div>
    </div>
      </el-tab-pane>

      <el-tab-pane label="推送与统计" name="ding">

    <!-- 每周工时排名发群 -->
    <div class="page-card">
      <div class="page-title sub">每周工时排名（发钉钉群）</div>
      <div class="digest-row">
        <el-switch
          :model-value="rankInfo?.enabled"
          :loading="savingRank"
          @change="(v: any) => toggleRankEnabled(!!v)"
        />
        <span>每周自动发送</span>
        <el-time-select
          v-model="rankTime"
          start="00:00"
          step="00:05"
          end="23:55"
          placeholder="发送时间"
          class="digest-time"
        />
        <span class="muted">每周日</span>
        <el-button size="small" :loading="savingRank" @click="saveRankTime">保存时间</el-button>
        <span v-if="rankInfo?.next" class="muted">下次发送：{{ rankInfo.next }}</span>
      </div>
      <div class="digest-row">
        <span class="muted">发送群</span>
        <el-select
          v-model="rankGroupIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          size="small"
          placeholder="选择接收排名的钉钉群（可多选，如公司大群）"
          class="rank-groups"
        >
          <el-option v-for="g in rankGroupOptions" :key="g.conversationId" :label="g.groupName" :value="g.conversationId" />
        </el-select>
        <el-button size="small" :loading="savingRank" @click="saveRankGroups">保存群</el-button>
      </div>
      <div class="digest-row">
        <el-button size="small" :loading="rankPreviewing" @click="loadRankPreview">预览本周榜单</el-button>
        <el-button type="primary" size="small" :loading="rankPublishing" @click="publishRankNow">立即发送到群</el-button>
        <span class="muted">统计范围：本周（周一至今）日报里提取到的工时</span>
      </div>
      <div v-if="rankPreview" class="rank-preview">
        <div class="muted">
          {{ rankPreview.weekLabel }} {{ rankPreview.rangeText }}· 填报 {{ rankPreview.reportedMembers }}/{{ rankPreview.totalMembers }} 人· 合计 {{ rankPreview.totalHours }} 小时
        </div>
        <div v-for="it in rankPreview.top" :key="it.userId" class="rank-line">
          第{{ it.rank }}名 {{ it.name }}｜{{ it.groupName }}｜{{ it.hours }} 小时
        </div>
        <div v-if="!rankPreview.top?.length" class="muted">本周还没有人填报工时</div>
        <pre class="rank-text">{{ rankPreview.text }}</pre>
      </div>
      <div class="muted digest-tip">
        成员在日报里写一句「今天干了 X 小时」即会自动提取工时（详情里可修正）；每周日按此时间汇总全公司 Top10（姓名·项目组·时长）发到勾选的群。未填报的人数也会一并说明。
        <template v-if="rankInfo?.source === 'env'">当前为系统默认配置（未在后台设置过）。</template>
      </div>
    </div>

    <!-- 每日小组小结发群 -->
    <div class="page-card">
      <div class="page-title sub">每日小组小结（发各项目钉钉群）</div>
      <div class="digest-row">
        <el-switch
          :model-value="summaryInfo?.enabled"
          :loading="savingSummary"
          @change="(v: any) => toggleSummaryEnabled(!!v)"
        />
        <span>每天自动发送</span>
        <el-time-select
          v-model="summaryTime"
          start="00:00"
          step="00:05"
          end="23:55"
          placeholder="发送时间"
          class="digest-time"
        />
        <el-button size="small" :loading="savingSummary" @click="saveSummaryTime">保存时间</el-button>
        <span v-if="summaryInfo?.next" class="muted">下次发送：{{ summaryInfo.next }}</span>
      </div>
      <div class="digest-row">
        <el-button size="small" :loading="summaryPreviewing" @click="loadSummaryPreview">预览今日小结</el-button>
        <el-button type="primary" size="small" :loading="summaryPublishing" @click="publishSummaryNow">立即发送到各群</el-button>
        <span class="muted">逐项目发到各自绑定群；保密 / 回收站 / 未绑群的项目自动跳过</span>
      </div>
      <div v-if="summaryPreview" class="rank-preview">
        <div class="muted">{{ summaryPreview.date }} · 共 {{ summaryPreview.items?.length || 0 }} 个项目群</div>
        <div v-for="it in summaryPreview.items" :key="it.projectId" class="summary-item">
          <div class="summary-head">{{ it.projectName }} → {{ it.groupName }}</div>
          <pre class="rank-text">{{ it.text }}</pre>
        </div>
        <div v-if="!summaryPreview.items?.length" class="muted">没有已绑定钉钉群的活跃项目</div>
      </div>
      <div class="muted digest-tip">
        每个群只收到它自己项目的内容：任务预期（逾期未完成 + 今日到期 + 未完成总数）与当天日报（成员/负责人里谁已交、谁待补）。开启后每天按此时间自动发送；也可随时预览或立即发送。
        <template v-if="summaryInfo?.source === 'env'">当前为系统默认配置（未在后台设置过）。</template>
      </div>
    </div>

    <!-- 钉钉群消息统计 -->
    <div class="page-card">
      <div class="page-title sub">群消息统计（近 7 天）</div>
      <div class="stat-row">
        <div class="stat-num">{{ stats.total ?? 0 }}</div>
        <div class="muted">条消息落地</div>
      </div>
      <div v-if="stats.byDay?.length" class="bars">
        <div v-for="[day, count] in stats.byDay" :key="day" class="bar-col" :title="`${day}: ${count} 条`">
          <div class="bar" :style="{ height: barHeight(count) }"></div>
          <div class="bar-label">{{ day.slice(5) }}</div>
        </div>
      </div>
    </div>
      </el-tab-pane>

      <el-tab-pane label="用户反馈" name="feedback" lazy>
        <div class="page-card">
          <div class="page-title sub">用户反馈</div>
          <div class="digest-row">
            <el-radio-group v-model="fbFilter" size="small" @change="loadFeedbacks">
              <el-radio-button label="PENDING">未受理</el-radio-button>
              <el-radio-button label="ACCEPTED">已受理</el-radio-button>
              <el-radio-button label="ALL">全部</el-radio-button>
            </el-radio-group>
            <el-button type="primary" size="small" :loading="summarizing" @click="doSummarize">
              AI 总结{{ fbSel.length ? `所选（${fbSel.length}）` : '未受理' }}
            </el-button>
            <span class="muted fb-sum-tip">勾选若干条后让 AI 归纳成可直接交付开发的需求清单；不勾选则总结当前「未受理」全部。</span>
          </div>
          <el-table
            :data="feedbacks"
            v-loading="loadingFeedback"
            size="small"
            class="table"
            row-key="id"
            @selection-change="(v: any[]) => (fbSel = v)"
          >
            <el-table-column type="selection" width="42" reserve-selection />
            <el-table-column label="提交人" width="120">
              <template #default="{ row }">{{ row.user?.name || '—' }}</template>
            </el-table-column>
            <el-table-column prop="content" label="反馈内容" min-width="240" show-overflow-tooltip />
            <el-table-column label="时间" width="130">
              <template #default="{ row }">{{ fmt(row.createdAt, 'MM-DD HH:mm') }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'ACCEPTED' ? 'success' : 'info'" size="small">
                  {{ row.status === 'ACCEPTED' ? '已受理' : '未受理' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="toggleFbStatus(row)">
                  {{ row.status === 'ACCEPTED' ? '取消受理' : '受理' }}
                </el-button>
              </template>
            </el-table-column>
            <template #empty>暂无反馈</template>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 编辑用户 -->
    <el-dialog v-model="editVisible" title="编辑用户" width="min(92vw, 420px)">
      <el-form label-position="top" size="default">
        <el-form-item label="用户名（登录账号）" required>
          <el-input v-model="editUserForm.username" placeholder="2-20 位字母/数字/下划线" maxlength="20" />
        </el-form-item>
        <el-form-item label="真实姓名" required>
          <el-input v-model="editUserForm.name" placeholder="团队内显示的真实姓名" maxlength="30" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="editUserForm.phone" placeholder="选填，无需短信验证" maxlength="20" />
        </el-form-item>
        <el-form-item label="所属部门">
          <el-select v-model="editUserForm.departmentId" placeholder="未归属" clearable style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="其他部门（可多选，主部门之外）">
          <el-select v-model="editUserForm.additionalDepartmentIds" multiple collapse-tags placeholder="可加入的其他部门" style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" :disabled="d.id === editUserForm.departmentId" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="editUserForm.username && editUserId !== auth.user?.id"
          type="warning"
          :closable="false"
          show-icon
          class="pwd-tip"
          title="忘记密码？可在下方将密码重置为初始密码"
        />
      </el-form>
      <template #footer>
        <div class="footer-left">
          <el-button
            v-if="editUserForm.username && editUserId !== auth.user?.id"
            type="danger"
            text
            :loading="resettingPwd"
            @click="resetPassword"
          >
            重置密码
          </el-button>
        </div>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editingUser" @click="saveEditUser">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增用户 -->
    <el-dialog v-model="showCreateUser" title="新增用户" width="min(92vw, 420px)">
      <el-form label-position="top" size="default">
        <el-form-item label="用户名（登录账号）" required>
          <el-input v-model="createUserForm.username" placeholder="2-20 位字母/数字/下划线，如 zhangsan" maxlength="20" />
        </el-form-item>
        <el-form-item label="真实姓名" required>
          <el-input v-model="createUserForm.name" placeholder="团队内显示的真实姓名" maxlength="30" />
        </el-form-item>
        <el-form-item label="手机号" required>
          <el-input v-model="createUserForm.phone" placeholder="必填，无需短信验证" maxlength="20" />
        </el-form-item>
        <el-form-item label="所属部门">
          <el-select v-model="createUserForm.departmentId" placeholder="未归属" clearable style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="其他部门（可多选，主部门之外）">
          <el-select v-model="createUserForm.additionalDepartmentIds" multiple collapse-tags placeholder="可加入的其他部门" style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" :disabled="d.id === createUserForm.departmentId" />
          </el-select>
        </el-form-item>
        <div class="muted pwd-hint">
          初始密码：<b>Org123456</b>，该用户首次登录将被要求修改密码
        </div>
      </el-form>
      <template #footer>
        <el-button @click="showCreateUser = false">取消</el-button>
        <el-button type="primary" :loading="creatingUser" @click="createUser">创建</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑部门 -->
    <el-dialog v-model="deptVisible" :title="deptEditId ? '编辑部门' : '新增部门'" width="min(92vw, 420px)">
      <el-form label-position="top" size="default">
        <el-form-item label="部门名称" required>
          <el-input v-model="deptForm.name" placeholder="如：机器人研发部" maxlength="30" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="deptForm.description" type="textarea" :rows="2" maxlength="120" placeholder="选填，部门主要职责" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="deptVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingDept" @click="saveDept">保存</el-button>
      </template>
    </el-dialog>

    <!-- 反馈 AI 总结结果（便于直接复制给另一个 AI 开发） -->
    <el-dialog v-model="summaryVisible" title="AI 总结（可复制给开发）" width="min(94vw, 720px)">
      <el-input v-model="summaryText" type="textarea" :autosize="{ minRows: 8, maxRows: 24 }" readonly />
      <template #footer>
        <el-button @click="summaryVisible = false">关闭</el-button>
        <el-button type="primary" @click="copySummary">复制</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { integrationsApi, usersApi, departmentsApi, documentsApi, authApi, projectsApi, agentApi, meetingsApi, feedbackApi } from '../../api';
import { fmt, formatBytes } from '../../utils/format';
import { useAuthStore } from '../../stores/auth';
import DepartmentView from '../DepartmentView.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

/** 大 tab：成员与组织 / 部门管理 / 审批与集成 / 进展与首页 / AI 与助手 / 推送与统计（与地址栏 ?tab= 同步）
 *  「部门管理」吞下了原侧边菜单「部门」：部门表格 + 部门详情页（成员/项目/文档/文件/日报规则/汇报树）
 *  tab 文案刻意压到 5 字以内：手机窄屏上多个 tab 要能一屏放下，否则最后一个会被裁掉 */
const ADM_TABS = ['org', 'departments', 'approve', 'digest', 'ai', 'ding', 'feedback'];
const tab = ref(String(route.query.tab || 'org'));
if (!ADM_TABS.includes(tab.value)) tab.value = 'org';

function onTabChange(name: any) {
  tab.value = String(name || 'org');
  const q = { ...route.query };
  if (tab.value === 'org') delete q.tab;
  else q.tab = tab.value;
  router.replace({ query: q });
  if (tab.value === 'feedback') loadFeedbacks();
}
watch(
  () => route.query.tab,
  (v) => {
    const t = ADM_TABS.includes(String(v)) ? String(v) : 'org';
    if (t !== tab.value) tab.value = t;
  },
);

// ---- 键盘 ←/→ 切换后台顶部所有大 Tab（在输入框/弹窗/下拉里打字时不拦，避免误切） ----
function onAdmKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
  const idx = ADM_TABS.indexOf(tab.value);
  if (idx < 0) return;
  const step = e.key === 'ArrowRight' ? 1 : -1;
  const next = ADM_TABS[(idx + step + ADM_TABS.length) % ADM_TABS.length];
  onTabChange(next);
}

// ---- 用户反馈 ----
const feedbacks = ref<any[]>([]);
const loadingFeedback = ref(false);
const fbFilter = ref<'PENDING' | 'ACCEPTED' | 'ALL'>('PENDING');
const fbSel = ref<any[]>([]);
const summaryVisible = ref(false);
const summaryText = ref('');
const summarizing = ref(false);
async function loadFeedbacks() {
  loadingFeedback.value = true;
  try {
    feedbacks.value = await feedbackApi.list(fbFilter.value);
  } finally {
    loadingFeedback.value = false;
  }
}
async function toggleFbStatus(row: any) {
  const next = row.status === 'ACCEPTED' ? 'PENDING' : 'ACCEPTED';
  await feedbackApi.setStatus(row.id, next);
  await loadFeedbacks();
}
async function doSummarize() {
  const ids = fbSel.value.map((r) => r.id);
  summarizing.value = true;
  try {
    const res = await feedbackApi.summarize(ids);
    if (res?.ok && res.text) {
      summaryText.value = res.text;
      summaryVisible.value = true;
    } else {
      ElMessage.error(res?.message || 'AI 总结失败，请稍后重试');
    }
  } finally {
    summarizing.value = false;
  }
}
async function copySummary() {
  try {
    await navigator.clipboard.writeText(summaryText.value);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.warning('当前浏览器不支持自动复制，请手动选中文本复制');
  }
}

const users = ref<any[]>([]);
const loadingUsers = ref(false);
const showCreateUser = ref(false);
const creatingUser = ref(false);
const createUserForm = reactive({ username: '', name: '', phone: '', departmentId: '', additionalDepartmentIds: [] as string[] });
const editVisible = ref(false);
const editingUser = ref(false);
const resettingPwd = ref(false);
const editUserId = ref('');
const editUserForm = reactive({ username: '', name: '', phone: '', departmentId: '', additionalDepartmentIds: [] as string[] });

// ---- 部门与岗位 ----
const departments = ref<any[]>([]);
const loadingDepts = ref(false);
const deptVisible = ref(false);
const deptEditId = ref('');
const savingDept = ref(false);
const deptForm = reactive({ name: '', description: '' });
const positions = ref<string[]>([]);
const newPosition = ref('');
const integration = ref<any>({});
const stats = ref<{ total: number; byDay: [string, number][] }>({ total: 0, byDay: [] });
const digestInfo = ref<any>(null);
const digestTime = ref('');
const savingDigest = ref(false);
// 首页项目进展展示条数
const homeCount = ref(3);
const savingHome = ref(false);
const aiLogInfo = ref<any>(null);
const savingAiLogEnabled = ref(false);
const sendingAiLog = ref(false);
// 每周工时排名（发群）
const rankInfo = ref<any>(null);
const rankTime = ref('21:00');
const rankGroupIds = ref<string[]>([]);
const rankGroupOptions = ref<{ conversationId: string; groupName: string }[]>([]);
const savingRank = ref(false);
const rankPreview = ref<any>(null);
const rankPreviewing = ref(false);
const rankPublishing = ref(false);
// 每日小组小结（发各项目群）
const summaryInfo = ref<any>(null);
const summaryTime = ref('18:00');
const savingSummary = ref(false);
const summaryPreview = ref<any>(null);
const summaryPreviewing = ref(false);
const summaryPublishing = ref(false);
const agentInfo = ref<any>(null);
const savingAgentEnabled = ref(false);

/** AI 日志自动发送时间展示：cron 为简单形式（m h * * *）时转 HH:mm，否则显示原文 */
const aiLogTimeLabel = computed(() => {
  const cron: string = (aiLogInfo.value?.cron ?? '').trim();
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron);
  if (!m) return cron || '08:00';
  return `${String(Number(m[2])).padStart(2, '0')}:${String(Number(m[1])).padStart(2, '0')}`;
});

const maxCount = computed(() => Math.max(1, ...(stats.value.byDay || []).map(([, c]) => c)));

function barHeight(count: number) {
  return `${Math.round((count / maxCount.value) * 80)}px`;
}

async function setRole(row: any, role: string) {
  await usersApi.setRole(row.id, role);
  row.role = role;
  ElMessage.success('角色已更新');
}

async function setActive(row: any, active: boolean) {
  await usersApi.setActive(row.id, active);
  row.active = active;
  ElMessage.success(active ? '已启用' : '已禁用');
}

/** 以该用户身份预览：向后台申请带预览标记的短期 token，切换登录态后跳转首页 */
async function previewUser(row: any) {
  const res = await authApi.impersonate(row.id);
  auth.startImpersonation(res.accessToken, res.user);
  ElMessage.success(`已切换为「${row.name}」的身份预览，排查完成后请点击顶部「退出预览」`);
  router.push('/');
}

/** 调整用户所属部门（清空传 null） */
async function setUserDept(row: any, departmentId: string | null) {
  await usersApi.update(row.id, { departmentId });
  row.departmentId = departmentId;
  ElMessage.success('部门已更新');
}

/** 待加入组织：与前端路由闸、后端 OrgGuard 完全同口径（仅普通成员，管理员与部门负责人不受限） */
function isPendingOrg(row: any) {
  return row.role === 'MEMBER' && !row.departmentId && row.active !== false;
}

// ---- 用户列表排序辅助（角色/部门/状态无独立 prop，按显示语义排序）----
const ROLE_ORDER: Record<string, number> = { ADMIN: 0, DEPT_LEADER: 1, PROJECT_LEADER: 2, MEMBER: 3 };
function sortUserRole(a: any, b: any) {
  return (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9);
}
function deptNameById(id: string | null) {
  return id ? departments.value.find((d) => d.id === id)?.name || '' : '';
}
/** 额外部门（主部门之外）：与主部门去重，避免同时挂主/额的那个人自己重复显示 */
function extraDepts(row: any) {
  const extra = row.extraDepartments || [];
  return extra.filter((d: any) => d.id !== row.departmentId);
}
/** 部门列排序键：主部门名 + 全部额外部门名（只看主部门会把「只在额外部门里」的人排成一堆空位） */
function deptSortKey(row: any) {
  return [deptNameById(row.departmentId), ...extraDepts(row).map((d: any) => d.name)].filter(Boolean).join('·');
}
function sortUserDept(a: any, b: any) {
  return deptSortKey(a).localeCompare(deptSortKey(b), 'zh');
}
/** 部门列筛选：主 ∪ 额外命中即算（勾「研发」能看到只在研发挂额外部门的人） */
const deptFilters = computed(() => [
  ...departments.value.map((d) => ({ text: d.name, value: d.id })),
  { text: '未归属', value: '__none__' },
]);
function filterUserDept(value: string, row: any) {
  if (value === '__none__') return !row.departmentId && !extraDepts(row).length;
  return row.departmentId === value || extraDepts(row).some((d: any) => d.id === value);
}
/** 直属上级候选：全体在职用户（去掉自己），已设上级不在候选里时补上以免回显丢失 */
function reporteeOptions(row: any) {
  const list = users.value.filter((u) => u.active !== false && u.id !== row.id);
  if (row.reportsToId && !list.some((u) => u.id === row.reportsToId)) {
    const cur = users.value.find((u) => u.id === row.reportsToId);
    if (cur) return [cur, ...list];
  }
  return list;
}
function sortUserActive(a: any, b: any) {
  return Number(a.active) - Number(b.active);
}

/** 部门负责人候选：仅本部门成员（主部门 ∪ 额外部门）；若已设负责人不在本部门也一并列出以免回显丢失 */
function leaderOptions(row: any) {
  const members = users.value.filter((u) => u.departmentId === row.id || (u.extraDepartments || []).some((d: any) => d.id === row.id));
  if (row.leaderId && !members.some((u) => u.id === row.leaderId)) {
    const cur = users.value.find((u) => u.id === row.leaderId);
    if (cur) return [cur, ...members];
  }
  return members;
}

// ---------- 部门管理 ----------
async function loadDepartments() {
  loadingDepts.value = true;
  try {
    departments.value = await departmentsApi.list();
  } finally {
    loadingDepts.value = false;
  }
}

function openCreateDept() {
  deptEditId.value = '';
  deptForm.name = '';
  deptForm.description = '';
  deptVisible.value = true;
}

function openEditDept(row: any) {
  deptEditId.value = row.id;
  deptForm.name = row.name ?? '';
  deptForm.description = row.description ?? '';
  deptVisible.value = true;
}

async function saveDept() {
  const name = deptForm.name.trim();
  if (!name) {
    ElMessage.warning('部门名称必填');
    return;
  }
  savingDept.value = true;
  try {
    if (deptEditId.value) {
      await departmentsApi.update(deptEditId.value, { name, description: deptForm.description.trim() || undefined });
    } else {
      await departmentsApi.create({ name, description: deptForm.description.trim() || undefined });
    }
    ElMessage.success('部门已保存');
    deptVisible.value = false;
    await loadDepartments();
  } finally {
    savingDept.value = false;
  }
}

async function removeDept(row: any) {
  const c = row._count || {};
  const proj = c.projectLinks ?? c.projects ?? 0;
  const mem = c.members ?? 0;
  const owned = (c.docs ?? 0) + (c.files ?? 0) + (c.folders ?? 0);
  const esc = (s: string) => String(s).replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]!));
  const notes: string[] = [];
  if (proj) notes.push(`${proj} 个「主要关联」项目将解除与本部门的关联（项目本身保留）`);
  if (mem) notes.push(`${mem} 名成员将变为未分配部门（账号保留）`);
  const noteLine = notes.length ? notes.join('；') : '该部门无关联项目与成员';
  const warnLine = owned
    ? `<br><b style="color:#e6a23c">注意：该部门下的 ${owned} 项文档/文件/文件夹将被一并永久删除。</b>`
    : '';
  try {
    await ElMessageBox.confirm(
      `确定删除部门「${esc(row.name)}」？<br>${noteLine}。${warnLine}`,
      '删除部门',
      { type: owned ? 'warning' : 'info', confirmButtonText: '删除', dangerouslyUseHTMLString: true },
    );
  } catch {
    return;
  }
  await departmentsApi.remove(row.id);
  ElMessage.success('部门已删除');
  await loadDepartments();
}

/** 设置/取消部门负责人（后端自动升降该用户全局角色） */
async function setDeptLeader(row: any, userId: string | null) {
  await departmentsApi.setLeader(row.id, userId);
  ElMessage.success(userId ? '负责人已设置' : '已取消负责人');
  await loadDepartments();
  users.value = await usersApi.list();
}

/** 保存共管人名单：后端会同步做角色升降（入选升 DEPT_LEADER，移出且不再管任何部门/项目则降回 MEMBER） */
async function setDeptManagers(row: any, userIds: string[]) {
  const next = (userIds || []).filter((u) => u !== row.leaderId);
  try {
    await departmentsApi.setManagers(row.id, next);
    ElMessage.success(next.length ? `已设置 ${next.length} 名共管人` : '已清空共管人');
  } finally {
    await loadDepartments();
    users.value = await usersApi.list();
  }
}

/** 改直属上级（管理员可改任意人；清空=置为根） */
async function setUserReportsTo(row: any, parentId: string | null) {
  try {
    await departmentsApi.setReportsTo(row.id, parentId);
    row.reportsToId = parentId;
    ElMessage.success(parentId ? '已更新直属上级' : '已置为根（无上级）');
  } catch {
    // 拦截器已提示（如成环），重拉一次列表把回显恢复正常值
    users.value = await usersApi.list();
  }
}

async function updateDeptSort(row: any, sortOrder: number) {
  await departmentsApi.update(row.id, { sortOrder });
  row.sortOrder = sortOrder;
  await loadDepartments();
}

// ---------- 岗位清单 ----------
async function loadPositions() {
  positions.value = await departmentsApi.positions().catch(() => []);
}

async function persistPositions() {
  positions.value = await departmentsApi.savePositions(positions.value);
}

async function addPosition() {
  const p = newPosition.value.trim();
  if (!p) return;
  if (positions.value.includes(p)) {
    ElMessage.warning('该岗位已存在');
    return;
  }
  positions.value = [...positions.value, p];
  await persistPositions();
  newPosition.value = '';
}

function removePosition(p: string) {
  positions.value = positions.value.filter((x) => x !== p);
  persistPositions();
}

/** 管理员创建用户（用户名/真实姓名/手机号，默认密码，首次登录强制改密） */
async function createUser() {
  const username = createUserForm.username.trim();
  const name = createUserForm.name.trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) {
    ElMessage.warning('用户名需 2-20 位字母/数字/下划线');
    return;
  }
  if (name.length < 2) {
    ElMessage.warning('请输入真实姓名（至少 2 个字符）');
    return;
  }
  if (!createUserForm.phone.trim()) {
    ElMessage.warning('请输入手机号');
    return;
  }
  creatingUser.value = true;
  try {
    const created: any = await usersApi.create({
      username,
      name,
      phone: createUserForm.phone.trim(),
      departmentId: createUserForm.departmentId || null,
      additionalDepartmentIds: createUserForm.additionalDepartmentIds,
    });
    ElMessage.success(`已创建用户 ${created.username}，初始密码 Org123456`);
    showCreateUser.value = false;
    Object.assign(createUserForm, { username: '', name: '', phone: '', departmentId: '', additionalDepartmentIds: [] });
    users.value = await usersApi.list();
  } finally {
    creatingUser.value = false;
  }
}

/** 打开编辑用户弹窗 */
function openEditUser(row: any) {
  editUserId.value = row.id;
  editUserForm.username = row.username || '';
  editUserForm.name = row.name || '';
  editUserForm.phone = row.phone || '';
  editUserForm.departmentId = row.departmentId || '';
  editUserForm.additionalDepartmentIds = (row.extraDepartments || []).map((d: any) => d.id);
  editVisible.value = true;
}

/** 重置该用户密码为默认初始密码（下次登录强制修改）；不能重置自己 */
async function resetPassword() {
  const name = editUserForm.name || editUserForm.username;
  await ElMessageBox.confirm(
    `确定将「${name}」的密码重置为初始密码 Org123456 吗？\n该用户下次登录时将被要求修改密码。`,
    '重置密码',
    { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' },
  );
  resettingPwd.value = true;
  try {
    await usersApi.resetPassword(editUserId.value);
    ElMessage.success('密码已重置为 Org123456（该用户下次登录需修改密码）');
    editVisible.value = false;
  } finally {
    resettingPwd.value = false;
  }
}

/** 保存编辑用户资料 */
async function saveEditUser() {
  const username = editUserForm.username.trim();
  const name = editUserForm.name.trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(username)) {
    ElMessage.warning('用户名需 2-20 位字母/数字/下划线');
    return;
  }
  if (name.length < 2) {
    ElMessage.warning('请输入真实姓名（至少 2 个字符）');
    return;
  }
  editingUser.value = true;
  try {
    await usersApi.update(editUserId.value, {
      username,
      name,
      phone: editUserForm.phone.trim() || undefined,
      departmentId: editUserForm.departmentId || null,
      additionalDepartmentIds: editUserForm.additionalDepartmentIds,
    });
    ElMessage.success('用户资料已更新');
    editVisible.value = false;
    users.value = await usersApi.list();
  } finally {
    editingUser.value = false;
  }
}

/** 删除用户（仅管理员；其名下项目/任务/文档等转移给当前管理员，个人数据删除） */
async function removeUser(row: any) {
  try {
    await ElMessageBox.confirm(
      `确定删除用户「${row.name}」？删除后无法恢复；其负责的项目、创建的任务与文档将转移为你的资产。`,
      '删除用户',
      { type: 'warning', confirmButtonText: '删除' },
    );
  } catch {
    return; // 用户取消
  }
  await usersApi.remove(row.id);
  ElMessage.success('用户已删除');
  users.value = await usersApi.list();
}

/** 保存每日团队进展推送时间（北京时间 HH:mm，保存后立即重新注册定时） */
async function saveDigestTime() {
  if (!digestTime.value) {
    ElMessage.warning('请选择推送时间');
    return;
  }
  savingDigest.value = true;
  try {
    digestInfo.value = await integrationsApi.saveDigestSchedule(digestTime.value);
    ElMessage.success(`推送时间已设为每天 ${digestTime.value}（北京时间）`);
  } finally {
    savingDigest.value = false;
  }
}

/** 开关「每天自动发送」（保存后立即注册/移除定时，无需重启） */
async function toggleAiLogEnabled(enabled: boolean) {
  savingAiLogEnabled.value = true;
  try {
    aiLogInfo.value = await integrationsApi.saveAiLogEnabled(enabled);
    ElMessage.success(enabled ? '已开启每天自动发送' : '已关闭每天自动发送');
  } finally {
    savingAiLogEnabled.value = false;
  }
}

/** 拉取每周工时排名设置与候选群（仅管理员） */
async function loadWorkRank() {
  try {
    const s = await integrationsApi.workRankSettings();
    rankInfo.value = s;
    rankTime.value = s?.time || '21:00';
    rankGroupIds.value = (s?.groups ?? []).map((g: any) => g.conversationId);
  } catch {
    // 非管理员或读取失败时保留默认
  }
  try {
    rankGroupOptions.value = await meetingsApi.groupOptions();
  } catch {
    rankGroupOptions.value = [];
  }
}

/** 重拉设置（保存后刷新开关状态与下次触发时间） */
async function refreshWorkRank() {
  rankInfo.value = await integrationsApi.workRankSettings();
  rankTime.value = rankInfo.value?.time || rankTime.value;
  rankGroupIds.value = (rankInfo.value?.groups ?? []).map((g: any) => g.conversationId);
}

/** 开关「每周自动发送」（关闭时后端会移除定时） */
async function toggleRankEnabled(enabled: boolean) {
  savingRank.value = true;
  try {
    await integrationsApi.saveWorkRankSettings({ enabled });
    await refreshWorkRank();
    ElMessage.success(enabled ? '已开启每周自动发送' : '已关闭每周自动发送（定时已移除）');
  } finally {
    savingRank.value = false;
  }
}

/** 保存每周日发送时间 */
async function saveRankTime() {
  if (!rankTime.value) {
    ElMessage.warning('请选择发送时间');
    return;
  }
  savingRank.value = true;
  try {
    await integrationsApi.saveWorkRankSettings({ time: rankTime.value });
    await refreshWorkRank();
    ElMessage.success(`已设为每周日 ${rankTime.value}（北京时间）发送`);
  } finally {
    savingRank.value = false;
  }
}

/** 保存接收排名的钉钉群 */
async function saveRankGroups() {
  if (!rankGroupIds.value.length) {
    ElMessage.warning('请至少选择一个发送群');
    return;
  }
  savingRank.value = true;
  try {
    await integrationsApi.saveWorkRankSettings({ groupIds: rankGroupIds.value });
    await refreshWorkRank();
    ElMessage.success(`已保存 ${rankGroupIds.value.length} 个发送群`);
  } finally {
    savingRank.value = false;
  }
}

/** 预览本周榜单与群消息正文（不发群） */
async function loadRankPreview() {
  rankPreviewing.value = true;
  try {
    rankPreview.value = await integrationsApi.workRankPreview();
  } finally {
    rankPreviewing.value = false;
  }
}

/** 立即发送到后台勾选的群（不受开关限制） */
async function publishRankNow() {
  if (!rankGroupIds.value.length) {
    ElMessage.warning('请先选择并保存发送群');
    return;
  }
  rankPublishing.value = true;
  try {
    const r = await integrationsApi.publishWorkRank();
    rankPreview.value = r?.result ?? rankPreview.value;
    const okList = (r?.groups ?? []).filter((g: any) => g.ok);
    const failed = (r?.groups ?? []).filter((g: any) => !g.ok);
    if (r?.skipped) ElMessage.warning(`未发送：${r.reason}`);
    else if (failed.length) ElMessage.warning(`已发 ${okList.length} 个群，失败：${failed.map((g: any) => `${g.groupName}（${g.error || '未知'}）`).join('、')}`);
    else ElMessage.success(`已发送到 ${okList.length} 个群`);
  } finally {
    rankPublishing.value = false;
  }
}

/** 载入每日小组小结设置 */
async function loadDailySummary() {
  try {
    const s = await integrationsApi.dailySummarySettings();
    summaryInfo.value = s;
    summaryTime.value = s?.time || '18:00';
  } catch {
    // 非管理员或读取失败时保留默认
  }
}

/** 重拉设置（保存后刷新开关状态与下次触发时间） */
async function refreshDailySummary() {
  summaryInfo.value = await integrationsApi.dailySummarySettings();
  summaryTime.value = summaryInfo.value?.time || summaryTime.value;
}

/** 开关「每天自动发送」（关闭时后端会移除定时） */
async function toggleSummaryEnabled(enabled: boolean) {
  savingSummary.value = true;
  try {
    await integrationsApi.saveDailySummarySettings({ enabled });
    await refreshDailySummary();
    ElMessage.success(enabled ? '已开启每天自动发送' : '已关闭每天自动发送（定时已移除）');
  } finally {
    savingSummary.value = false;
  }
}

/** 保存每天发送时间 */
async function saveSummaryTime() {
  if (!summaryTime.value) {
    ElMessage.warning('请选择发送时间');
    return;
  }
  savingSummary.value = true;
  try {
    await integrationsApi.saveDailySummarySettings({ time: summaryTime.value });
    await refreshDailySummary();
    ElMessage.success(`已设为每天 ${summaryTime.value}（北京时间）发送`);
  } finally {
    savingSummary.value = false;
  }
}

/** 预览今日各项目小结（不发群） */
async function loadSummaryPreview() {
  summaryPreviewing.value = true;
  try {
    summaryPreview.value = await integrationsApi.dailySummaryPreview();
  } finally {
    summaryPreviewing.value = false;
  }
}

/** 立即发送到各项目绑定群（不受开关限制） */
async function publishSummaryNow() {
  summaryPublishing.value = true;
  try {
    const r = await integrationsApi.publishDailySummary();
    const okList = (r?.groups ?? []).filter((g: any) => g.ok);
    const failed = (r?.groups ?? []).filter((g: any) => !g.ok);
    if (r?.skipped) ElMessage.warning(`未发送：${r.reason}`);
    else if (failed.length) ElMessage.warning(`已发 ${okList.length} 个群，失败 ${failed.length} 个：${failed.map((g: any) => `${g.groupName}（${g.error || '未知'}）`).join('、')}`);
    else ElMessage.success(`已发送到 ${okList.length} 个项目群`);
  } finally {
    summaryPublishing.value = false;
  }
}

/** 开关管理者 Agent 悬浮窗总闸（存 Setting，保存即生效） */
async function toggleAgentEnabled(enabled: boolean) {
  savingAgentEnabled.value = true;
  try {
    await agentApi.saveConfig({ enabled });
    agentInfo.value = { ...agentInfo.value, enabled };
    ElMessage.success(enabled ? '已开启小助手（管理者档）' : '已关闭小助手（对所有角色隐藏入口）');
  } finally {
    savingAgentEnabled.value = false;
  }
}

/** 员工档开关：只放开“问自己”的能力，带对外发送副作用的执行路由在服务端强制管理者档 */
async function toggleAgentMemberEnabled(enabled: boolean) {
  savingAgentEnabled.value = true;
  try {
    await agentApi.saveConfig({ memberEnabled: enabled });
    agentInfo.value = { ...agentInfo.value, memberEnabled: enabled };
    ElMessage.success(enabled ? '已开放员工档（普通员工可查自己的进度与知识检索）' : '已关闭员工档（小助手只对负责人可见）');
  } finally {
    savingAgentEnabled.value = false;
  }
}

/** 立即发送前一天的 DeepSeek 调用日志文件（不受自动发送开关限制） */
async function sendAiLogNow() {
  sendingAiLog.value = true;
  try {
    const res: any = await integrationsApi.sendAiLog();
    if (res?.sent) {
      ElMessage.success(
        res.exists
          ? `已发送 ${res.date} 日志给「${res.to}」`
          : `${res.date} 无 DeepSeek 调用记录，已私聊告知「${res.to}」`,
      );
    } else {
      ElMessage.error(`发送失败：${res?.error ?? '未知错误'}`);
    }
    aiLogInfo.value = await integrationsApi.aiLogSettings();
  } finally {
    sendingAiLog.value = false;
  }
}

// ---------------- 文档审批（文件「全员可见」申请） ----------------
const apStatus = ref('PENDING');
const apFiles = ref<any[]>([]);
const apPending = ref(0);
const apLoading = ref(false);

async function loadApprovals() {
  apLoading.value = true;
  try {
    const data = await documentsApi.approvals(apStatus.value);
    apFiles.value = data.files || [];
    apPending.value = data.pending ?? 0;
  } finally {
    apLoading.value = false;
  }
}

const AP_INLINE = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'webm', 'txt', 'md'];

function apExt(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 审批前看内容：审批者本就是管理员，走 API 流式代理（MinIO 不对外） */
async function approvalPreview(row: any) {
  if (!AP_INLINE.includes(apExt(row.name || ''))) {
    ElMessage.info('该格式不支持在线预览，请先下载后用本地应用打开');
    return;
  }
  const blob = await documentsApi.content(row.id, { inline: true });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function approvalDownload(row: any) {
  const blob = await documentsApi.content(row.id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = row.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function approveFile(row: any) {
  try {
    await ElMessageBox.confirm(
      `同意「${row.name}」对所有人员可见？通过后公司里其他部门/项目的人也能看到并下载该文件。`,
      '同意全员可见',
      { type: 'warning', confirmButtonText: '同意' },
    );
  } catch {
    return;
  }
  await documentsApi.review(row.id, 'APPROVE');
  ElMessage.success('已同意，文件现在全员可见');
  await loadApprovals();
}

async function rejectFile(row: any) {
  const { value } = await ElMessageBox.prompt('驳回理由（会通知上传者，可留空）', '驳回全员可见申请', {
    inputType: 'textarea',
    confirmButtonText: '驳回',
    cancelButtonText: '取消',
  }).catch(() => ({ value: null as string | null }));
  if (value === null) return;
  await documentsApi.review(row.id, 'REJECT', value || undefined);
  ElMessage.success('已驳回，文件降为仅上传者可见');
  await loadApprovals();
}

/** 保存首页每项目进展展示条数（0~10，保存后首页立即生效） */
async function saveHomeCount() {
  savingHome.value = true;
  try {
    const res = await projectsApi.saveHomeDisplay(Number(homeCount.value) || 0);
    homeCount.value = typeof res?.count === 'number' ? res.count : homeCount.value;
    ElMessage.success('已保存，首页生效');
  } finally {
    savingHome.value = false;
  }
}

onMounted(async () => {
  loadingUsers.value = true;
  try {
    users.value = await usersApi.list();
  } finally {
    loadingUsers.value = false;
  }
  integration.value = await integrationsApi.status();
  stats.value = await integrationsApi.messageStats({ days: 7 });
  digestInfo.value = await integrationsApi.digestSchedule();
  digestTime.value = digestInfo.value?.time || '20:00';
  aiLogInfo.value = await integrationsApi.aiLogSettings();
  await loadWorkRank();
  await loadDailySummary();
  agentInfo.value = await agentApi.getConfig().then((c: any) => ({ enabled: !!c?.enabled, memberEnabled: c?.memberEnabled !== false })).catch(() => ({ enabled: false, memberEnabled: true }));
  try {
    const hd = await projectsApi.homeDisplay();
    homeCount.value = typeof hd?.count === 'number' ? hd.count : 3;
  } catch {
    // 非管理员或读取失败时保留默认
  }
  await Promise.all([loadDepartments(), loadPositions(), loadApprovals().catch(() => undefined)]);
  // 键盘 ←/→ 切换大 Tab；深链 ?tab=feedback 直达时首次加载反馈列表
  window.addEventListener('keydown', onAdmKey);
  if (tab.value === 'feedback') loadFeedbacks();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onAdmKey);
});
</script>

<style scoped>
/* 反馈 AI 总结按钮旁的说明文案：窄屏下换行铺满，不挤压前面的筛选与按钮 */
.fb-sum-tip {
  flex-basis: 100%;
  line-height: 1.5;
}
/* 大 tab 的胶囊样式与下边距均在 styles.css 里统一 */
/* 部门管理 tab 内嵌的部门页：去掉它自己的 .page 内边距与居中限制，避免与 tab 容器双重留白 */
.adm-tabs :deep(.page.embedded) {
  max-width: none;
  margin: 0;
  padding: 0;
}
/* 内嵌部门页的页头降为仅靠右排列「部门切换」的紧凑工具条（页面标题已由「管理后台」提供） */
.adm-tabs :deep(.page-title.title-embedded) {
  background: none;
  box-shadow: none;
  color: inherit;
  padding: 0;
  margin: 0 0 12px;
  border-radius: 0;
  justify-content: flex-end;
  min-height: auto;
}
.ap-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.ap-tip {
  font-size: 12px;
}
.ap-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ap-note {
  font-size: 12px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-space {
  font-size: 12px;
  max-width: 96px;
  display: inline-block;
  vertical-align: bottom;
}
.sub {
  font-size: 15px;
}
.table {
  width: 100%;
}
.user-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name-link {
  color: inherit;
  cursor: pointer;
}
.name-link:hover {
  color: var(--el-color-primary);
}
/* 额外部门 tag：挂在主部门下拉下方，一行装不下就换行 */
.dept-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.dept-tag {
  cursor: pointer;
}
.pending-tag {
  margin-left: 6px;
}
.integ-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.integ-card {
  border: 1px solid #ebeef5;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.integ-name {
  font-weight: 600;
  font-size: 14px;
}
.digest-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.digest-time {
  width: 140px;
}
.digest-tip {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.7;
}
.rank-groups {
  min-width: 260px;
  max-width: 520px;
  flex: 1;
}
.rank-preview {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 13px;
}
.rank-line {
  margin-top: 4px;
}
.rank-text {
  margin: 10px 0 0;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-family: inherit;
  white-space: pre-wrap;
  line-height: 1.7;
  font-size: 13px;
}
.summary-item {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
.summary-head {
  font-weight: 600;
  margin-bottom: 2px;
}
.stat-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.stat-num {
  font-size: var(--fs-num);
  font-weight: 700;
  color: var(--el-color-primary);
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 100px;
  padding: 10px 0;
  overflow-x: auto;
}
.bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.bar {
  width: 26px;
  background: linear-gradient(180deg, #7baeff, #428bff);
  border-radius: 4px 4px 0 0;
  min-height: 4px;
}
.bar-label {
  font-size: var(--fs-2xs);
  color: #909399;
}
.pwd-hint {
  font-size: 13px;
  color: #606266;
}
.pwd-tip {
  margin-top: 4px;
}
.footer-left {
  float: left;
}
.pos-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.pos-tag {
  margin: 0;
}
.pos-input {
  width: 200px;
}
</style>
