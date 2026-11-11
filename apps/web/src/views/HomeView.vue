<template>
  <div class="page">
    <!-- 欢迎横幅：问候 + 今日工作概览（录入统一走下方智能录入，不再放写日报/发公告按钮） -->
    <div class="hero">
      <div class="hero-main">
        <div class="hero-eyebrow">{{ today }}</div>
        <div class="hero-title">{{ greeting }}，{{ auth.user?.name }}</div>
        <div class="hero-caption">欢迎回来，这是你今天的工作概览</div>
      </div>
      <div class="hero-stats">
        <button type="button" class="hero-stat" title="查看我的待办任务" @click="goTodo">
          <b>{{ my.todo.length }}</b>
          <span>待办任务<el-icon :size="10"><ArrowRight /></el-icon></span>
        </button>
        <button type="button" class="hero-stat" title="查看我的逾期任务" @click="goOverdue">
          <b :class="{ warn: my.overdue > 0 }">{{ my.overdue }}</b>
          <span>逾期任务<el-icon :size="10"><ArrowRight /></el-icon></span>
        </button>
        <button type="button" class="hero-stat" title="查看本周工时排行" @click="goHours">
          <b>{{ hoursStat.weekHours }}<i>h</i></b>
          <span>本周工时<el-icon :size="10"><ArrowRight /></el-icon></span>
        </button>
        <button type="button" class="hero-stat" title="查看本月工时" @click="goHours">
          <b>{{ hoursStat.monthHours }}<i>h</i></b>
          <span>本月工时<el-icon :size="10"><ArrowRight /></el-icon></span>
        </button>
      </div>
    </div>

    <!-- 播报 + 右侧栏收起：同一行（播报占满剩余宽度，收起按钮贴最右；手机不显示按钮） -->
    <div class="broadcast-row">
      <!-- 智能播报（跑马灯）：悬停暂停并在下方下拉当前条目详情，点击可直接定位/跳到对应列表处理 -->
      <div class="broadcast-wrap" @mouseenter="onBroadcastEnter" @mouseleave="onBroadcastLeave">
        <div class="broadcast-bar">
          <span class="broadcast-tag">播报</span>
          <div class="broadcast-viewport">
            <div
              class="broadcast-track"
              :style="{ animationDuration: broadcastDur + 's', animationPlayState: broadcastPaused ? 'paused' : 'running' }"
            >
              <!-- 轨道渲染两份实现无缝循环（第二份仅供视觉，不参与交互） -->
              <span v-for="pass in 2" :key="'p' + pass" class="broadcast-seq" :aria-hidden="pass === 2">
                <span
                  v-for="(b, i) in broadcastItems"
                  :key="'b' + pass + i"
                  class="broadcast-item"
                  :class="{ hot: pass === 1 && hoverIdx === i, actable: !!b.actionLabel }"
                  @mouseenter="hoverItem = b; hoverIdx = i"
                  @click="goBroadcast(b)"
                >{{ b.text }}</span>
              </span>
            </div>
          </div>
        </div>
        <!-- 下拉详情：显示当前悬停这一条的完整内容 + 去处理入口（不用过渡：悬停时即时出现，避免后台标签页里过渡不结束导致面板卡住） -->
        <div v-if="broadcastPaused && hoverItem" class="broadcast-drop">
          <div class="bd-head">
            <span class="bd-badge">{{ hoverItem.badge }}</span>
            <b class="bd-title">{{ hoverItem.title }}</b>
            <button v-if="hoverItem.actionLabel" type="button" class="bd-act" @click="goBroadcast(hoverItem)">
              {{ hoverItem.actionLabel }} →
            </button>
          </div>
          <div class="bd-detail">{{ hoverItem.detail }}</div>
        </div>
      </div>

      <!-- 使用体验反馈入口：全员可见（含手机），点开弹窗提交，提交后自动同步到公司全员群 -->
      <button type="button" class="fb-btn" title="提交使用体验反馈（会同步到公司全员群）" @click="fbVisible = true">反馈</button>

      <!-- 桌面宽屏：右上角可收起右侧栏（团队公告/全部功能），收起后中间内容占满全宽；手机不显示此按钮 -->
      <div class="grid-tools">
        <button
          type="button"
          class="side-toggle"
          :title="sideCollapsed ? '展开右侧（团队公告 / 全部功能）' : '收起右侧，让中间内容占满宽度'"
          @click="sideCollapsed = !sideCollapsed"
        >
          <el-icon :size="12"><component :is="sideCollapsed ? 'ArrowLeft' : 'ArrowRight'" /></el-icon>
          {{ sideCollapsed ? '展开右侧' : '收起右侧' }}
        </button>
      </div>
    </div>

    <!-- 首页主网格：手机单列（靠 order 控制顺序：待办 → 录入 → 重点工作 → 进展 → 公告/榜单/入口），桌面两栏 -->
    <div class="home-grid" :class="{ 'side-collapsed': sideCollapsed }">
    <!-- 顶部 AI 对话录入框：默认收起（一行输入）；点输入框/右侧「选类别」才展开预设类别；发送后展开 AI 处理结果卡 -->
    <div class="page-card intake-card" :class="{ 'is-open': intakeOpen }">
      <div class="page-title intake-head">
        <span>智能录入</span>
        <span class="intake-sub">AI 自动识别 · 直接落库</span>
        <button type="button" class="intake-toggle" :class="{ on: intakeOpen }" @click="intakeOpen = !intakeOpen">
          {{ intakeOpen ? '收起类别' : '选类别' }}
          <el-icon :size="12"><ArrowDown /></el-icon>
        </button>
      </div>
      <div v-if="intakeOpen" class="intake-presets">
        <button
          v-for="p in INTAKE_PRESETS"
          :key="p.value"
          class="pill"
          :class="{ active: intakeCategory === p.value }"
          @click="pickCategory(p.value)"
        >
          <el-icon><component :is="p.icon" /></el-icon>&nbsp;{{ p.label }}
        </button>
      </div>
      <!-- 日报工时快捷档位：展开且未选其他类别时出现；不选则继续由 AI 从文字里识别 -->
      <div v-if="intakeOpen && (!intakeCategory || intakeCategory === 'DAILY')" class="intake-hours-row">
        <span class="hours-label">日报工时</span>
        <button
          v-for="h in HOUR_OPTIONS"
          :key="h"
          type="button"
          class="pill hours-pill"
          :class="{ active: intakeHoursPick === h }"
          @click="pickHours(h)"
        >
          {{ h }} 小时
        </button>
        <span class="muted hours-tip">只对日报生效，不选则由 AI 识别</span>
      </div>
      <el-input
        ref="intakeInputRef"
        v-model="intakeText"
        type="textarea"
        :autosize="{ minRows: intakeOpen ? 2 : 1, maxRows: 8 }"
        class="intake-input"
        placeholder="输入或说一句：日报 / 周报 / 任务 / 灵感…AI 会自动识别类别并直接录入（回车换行，点发送按钮提交）"
        @focus="intakeOpen = true"
      />
      <div class="intake-tools">
        <button class="plus-btn" title="更多能力（即将支持）" @click="notReady">+</button>
        <el-button
          :type="listening ? 'danger' : 'default'"
          :class="{ 'voice-pulse': listening }"
          :disabled="!srSupported"
          circle
          title="按住说话，松开结束"
          @mousedown.prevent="startVoice"
          @mouseup.prevent="stopVoice"
          @mouseleave.prevent="stopVoice"
          @touchstart.prevent="startVoice"
          @touchend.prevent="stopVoice"
          @touchcancel.prevent="stopVoice"
        >
          <el-icon :size="18"><Microphone /></el-icon>
        </el-button>
        <span v-if="!srSupported" class="muted voice-tip">当前浏览器不支持语音，请用 Chrome/Edge</span>
        <span v-else-if="listening" class="voice-tip listening">正在聆听…松开结束</span>
        <span v-else class="voice-tip"></span>
        <el-button type="primary" circle class="send-btn" :loading="submittingIntake" title="发送" @click="submitIntake">
          <el-icon :size="18"><Promotion /></el-icon>
        </el-button>
      </div>
      <!-- AI 处理结果卡：类别徽标 + 摘要 + 详情 + 撤销（任务待归属项目时提供一键选项目） -->
      <div v-if="intakeResult" class="intake-result">
        <div class="intake-result-head">
          <el-tag :type="catTagType(intakeResult.category)" effect="dark" size="small">{{ catLabel(intakeResult.category) }}</el-tag>
          <b class="intake-summary">{{ intakeResult.summary }}</b>
          <el-button
            v-if="intakeResult.undoable"
            text
            type="danger"
            size="small"
            :loading="undoing"
            class="undo-btn"
            @click="undoIntake"
          >撤销</el-button>
        </div>
        <div class="muted intake-detail">{{ intakeResult.detail }}</div>
        <!-- 日报：工时必须核对（漏填按 0 记），可在录入结果里直接改 -->
        <div v-if="intakeResult.category === 'DAILY'" class="intake-hours">
          <span class="intake-hours-label">当日工时<span class="intake-hours-required">*</span></span>
          <el-input-number
            v-model="intakeHours"
            :min="0"
            :max="24"
            :step="0.5"
            :precision="1"
            size="small"
            controls-position="right"
            placeholder="如 8"
            style="width: 120px"
          />
          <el-button size="small" type="primary" plain :loading="savingIntakeHours" @click="saveIntakeHours">
            保存工时
          </el-button>
          <span class="muted intake-hours-tip">
            {{ intakeHoursSaved ? '已保存，已计入工时排行' : '没识别到就先按 0 记；改成实际工时后点保存' }}
          </span>
        </div>
        <div v-if="intakeResult.needProject" class="need-project">
          <el-select v-model="pickedProjectId" placeholder="选择归属项目" size="small" filterable style="width: 200px">
            <el-option v-for="opt in intakeResult.projectOptions" :key="opt.id" :label="opt.name" :value="opt.id" />
          </el-select>
          <el-button type="primary" size="small" :loading="creatingTask" @click="confirmTaskWithProject">创建任务</el-button>
        </div>
      </div>
    </div>

    <!-- 重点工作任务 -->
    <div v-if="keyTasks.length" class="page-card key-card">
      <div class="page-title">
        <span>重点工作任务</span>
        <el-button text type="primary" size="small" @click="$router.push('/tasks?tab=board')">去任务看板 →</el-button>
      </div>
      <TaskUpdatePopover v-for="t in keyTasks" :key="t.id" :task="t" @open="openTask(t.id)">
        <div class="task-row" @click="openTask(t.id)">
          <el-tag :type="TASK_PRIORITY[t.priority]?.type" size="small">{{ TASK_PRIORITY[t.priority]?.label }}</el-tag>
          <span class="task-title ellipsis">{{ t.title }}</span>
          <span class="muted">{{ t.project?.name }}</span>
          <span class="muted">{{ t.assignee?.name || '未指派' }}</span>
          <span v-if="t.dueDate" class="due" :class="{ overdue: isOverdue(t.dueDate) }">{{ fmt(t.dueDate, 'MM-DD') }}</span>
        </div>
      </TaskUpdatePopover>
    </div>

    <!-- 我的工作时间安排：每个人首页可见（工作日排班决定当天是否被催日报），与「工作管理 → 我的工作时间」TAB 同一组件 -->
    <div class="page-card schedule-card">
      <WorkSchedulePanel :card="false" show-manage-link />
    </div>

        <!-- 我的项目进展 -->
    <div ref="progressSection" class="page-card progress-section" :class="{ 'section-flash': progressFlash }">
      <div class="page-title">
        <span>我的项目进展</span>
        <el-button text type="primary" size="small" @click="$router.push('/projects')">全部项目 →</el-button>
      </div>
      <div v-if="!projectUpdates.length" class="muted empty">
        暂无项目，去 <el-link type="primary" @click="$router.push('/projects')">创建/加入项目</el-link>
      </div>
      <div v-else class="progress-grid">
        <div v-for="p in sortedUpdates" :key="p.id" class="progress-card" @click="$router.push('/projects/' + p.id)">
          <div class="progress-head">
            <span class="dot" :style="{ background: p.color || '#428bff' }"></span>
            <span class="proj-name ellipsis" :title="p.name">{{ p.name }}</span>
            <!-- 保密项目：未签协议的成员拿不到进展正文，卡片上直接说明原因，避免看起来像「无进展」 -->
            <el-tag v-if="p.confidential" size="small" type="danger" effect="plain">🔒 保密</el-tag>
          </div>
          <!-- 完成度/健康度（百分比，大字号）：健康度按数值着色 -->
          <div class="progress-metrics">
            <div class="metric">
              <span class="metric-label">完成度</span>
              <span class="metric-num">{{ p.completionPercent ?? 0 }}<i>%</i></span>
            </div>
            <div class="metric">
              <span class="metric-label">健康度</span>
              <span class="metric-num" :class="healthClass(p.healthPercent)">{{ p.healthPercent ?? 0 }}<i>%</i></span>
            </div>
          </div>
          <!-- 群聊 AI 提取的进展条目：前缀为进展对应消息日（简写），文本为 AI 浓缩结论，绿色显示；当天进展特殊高亮；已转任务的条目蓝色显示并带徽标；点击条目弹出「从进展创建任务」；同项目内可拖拽（移动端长按）到另一条进展上合并 -->
          <div v-if="p.updates?.length" class="upd-list">
            <div
              v-for="u in p.updates"
              :key="u.id"
              class="upd-item"
              :class="{ fresh: isUpdateToday(u), converted: !!u.taskId, dragging: merge.isDragging(u), 'drag-over': merge.isDragOver(u) }"
              :title="u.taskId ? '已转为任务 · 点击可再次创建/关联：' + u.content : '从进展创建任务：' + u.content"
              :draggable="!isTouchDevice"
              :data-merge-key="u.id"
              @click.stop="openConvertFromProgress(p, u)"
              @dragstart="merge.onDragStart($event, u)"
              @dragover="merge.onDragOver($event, u)"
              @dragleave="merge.onDragLeave(u)"
              @drop="merge.onDrop($event, u)"
              @dragend="merge.onDragEnd()"
              @touchstart="merge.onTouchStart($event, u)"
              @touchmove="merge.onTouchMove($event)"
              @touchend="merge.onTouchEnd()"
              @touchcancel="merge.onTouchCancel()"
            >
              <span class="upd-date">{{ updateDate(u) }}</span>
              <span class="upd-text">{{ u.content }}</span>
              <span v-if="u.taskId" class="upd-conv">已转任务</span>
            </div>
          </div>
          <div v-else class="muted progress-empty">
            <span v-if="p.confidential">保密项目：在项目页签署保密协议后才会展示进展摘要</span>
            <span v-else-if="p.dingtalkGroupName">暂无进展，AI 将自动从群「{{ p.dingtalkGroupName }}」提取</span>
            <span v-else>暂无进展，AI 将自动从关联群聊提取</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 公告栏 + 两张全公司榜单 + 全部功能：桌面统一放右栏，榜单紧跟公告下面 -->
    <aside class="side-col">
    <div class="page-card announce-card">
      <div class="page-title">
        <span>团队公告</span>
        <el-button v-if="auth.isAdmin" text type="primary" size="small" @click="showCreate = true">发布公告</el-button>
      </div>
      <!-- 近 3 天会议活动：自动生成的置顶通知条目（不写进公告表），全员可见、登录后点一下就能打卡 -->
      <div v-if="boardRows.length" class="board-block">
        <div class="board-head">
          <span class="board-cap">会议活动 · 近 3 天</span>
          <el-button text type="primary" size="small" @click="$router.push('/meetings')">全部 →</el-button>
        </div>
        <div v-for="m in boardShown" :key="m.id" class="board-row">
          <el-tag class="board-kind" :type="m.kind === 'ACTIVITY' ? 'warning' : 'primary'" size="small" effect="plain">
            {{ m.kind === 'ACTIVITY' ? '活动' : '会议' }}
          </el-tag>
          <!-- 整行点开就是那场详情（站内深链，登录后可直达） -->
          <div class="board-main" @click="$router.push(m.link)">
            <span class="announce-title ellipsis">{{ m.title }}</span>
            <span class="board-meta muted">
              {{ boardTimeLabel(m) }} · {{ m.ownerName }} 组织<span v-if="m.location"> · {{ m.location }}</span> · 已打卡 {{ m.attendanceCount }} 人
            </span>
          </div>
          <span class="board-ops" @click.stop>
            <el-button
              v-if="m.canCheckin"
              type="success"
              size="small"
              round
              :loading="boardBusy === m.id"
              title="开始后 3 天内都能打卡，记为一次自主签到"
              @click="doBoardCheckin(m)"
            >打卡</el-button>
            <el-tag v-else-if="m.myCheckedIn" type="success" size="small" effect="plain">已打卡</el-tag>
            <el-tooltip v-else-if="m.fullAccess === false" :content="m.lockReason || '仅相关人员可查看完整内容并打卡'" placement="top">
              <el-tag type="warning" size="small" effect="plain">受限</el-tag>
            </el-tooltip>
            <el-tag v-else-if="m.notStarted" type="info" size="small" effect="plain">未开始</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">超 3 天</el-tag>
            <button type="button" class="board-link" title="复制该会议活动链接" @click="copyBoardLink(m)">链接</button>
          </span>
        </div>
        <button v-if="boardRows.length > BOARD_FOLD" type="button" class="board-fold" @click="boardExpanded = !boardExpanded">
          {{ boardExpanded ? '收起' : `展开全部 ${boardRows.length} 场` }}
        </button>
      </div>
      <div v-if="!announcements.length" class="muted empty">暂无公告</div>
      <div v-for="a in announcements" :key="a.id" class="announce" @click="openAnnouncement(a)">
        <el-tag v-if="a.pinned" type="danger" size="small" effect="dark" class="pin">置顶</el-tag>
        <span class="announce-title ellipsis">{{ a.title }}</span>
        <span class="muted">{{ a.author?.name }} · {{ timeAgo(a.createdAt) }}</span>
      </div>
    </div>

    <!-- 首页全公司榜单：上个月的 PBC 排行（上月无定稿则回退最近有评分月） + 一卡两页轮播 -->
    <HomeRankCard
      title="PBC 排行"
      :subtitle="pbcRankSubtitle"
      :rows="pbcRankRows"
      empty-text="上个月还没有定稿的 PBC 评分；上级复核定稿后自动上榜"
      class="pbc-rank-clickable"
      @click="$router.push('/reports?tab=pbc&view=rank')"
    />
    <HomeRankRotator :tabs="rankTabs" />

    <!-- 功能入口（按场景分组，移动端主入口区，覆盖全部低频页面） -->
    <div class="page-card entries-card">
      <div class="page-title"><span>全部功能</span></div>
      <div v-for="g in quickGroups" :key="g.title" class="entry-group">
        <div class="entry-group-title">{{ g.title }}</div>
        <div class="quick-grid">
          <div v-for="q in g.items" :key="q.path" class="quick" @click="$router.push(q.path)">
            <span class="quick-icon" :style="{ color: q.color, background: q.bg }">
              <el-icon :size="20"><component :is="q.icon" /></el-icon>
            </span>
            <span class="quick-label">{{ q.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 我的部门：上移到右栏末尾（与榜单同栏），不再坠在整个页面最下面 -->
    <div v-if="myDept" class="page-card dept-card" @click="$router.push(deptPath)">
      <div class="page-title">
        <span>我的部门</span>
        <el-button text type="primary" size="small" @click.stop="$router.push(deptPath)">部门详情 →</el-button>
      </div>
      <div class="dept-line">
        <el-tag type="primary" effect="plain" round>{{ myDept.name }}</el-tag>
        <!-- 一人可属多部门：其余部门用 +N 列出，每个都能点进去看（?id= 直达） -->
        <el-tag
          v-for="d in otherDepts"
          :key="d.id"
          type="info"
          effect="plain"
          round
          class="dept-extra"
          @click.stop="$router.push('/departments?id=' + d.id)"
          >+{{ d.name }}</el-tag
        >
        <span class="muted">负责人：{{ myDept.leader?.name || '未设置' }}</span>
        <span v-if="myDept.managers?.length" class="muted">管理：{{ myDept.managers.map((m: any) => m.name).join('、') }}</span>
        <span class="dept-stats">
          <span class="dept-chip">项目 <b>{{ myDept.projectCount }}</b></span>
          <span class="dept-chip">成员 <b>{{ myDept.memberCount }}</b></span>
          <span class="dept-chip">文档 <b>{{ myDept.docCount }}</b></span>
        </span>
      </div>
      <div v-if="myDept.description" class="muted dept-desc">{{ myDept.description }}</div>
    </div>
    <div v-else-if="auth.user && !auth.isAdmin" class="page-card dept-card">
      <div class="page-title">我的部门</div>
      <div class="muted empty">尚未归属部门，请联系管理员将你加入部门</div>
    </div>
    </aside>

    <!-- 我的待办 -->
    <div class="page-card todo-card">
      <div class="page-title">
        <span>我的待办</span>
        <div class="todo-tabs">
          <!-- 点「已完成」后任务会从待办列表消失，没个去处用户会以为被删了：给一个近 7 天完成的页签 -->
          <button class="tt" :class="{ on: todoTab === 'todo' }" @click="todoTab = 'todo'">待办 {{ my.todo.length }}</button>
          <button v-if="my.done.length" class="tt" :class="{ on: todoTab === 'done' }" @click="todoTab = 'done'">近 7 天完成 {{ my.done.length }}</button>
          <el-button text type="primary" size="small" @click="$router.push('/tasks')">全部任务 →</el-button>
        </div>
      </div>
      <div v-if="!todoRows.length" class="muted empty">{{ todoTab === 'todo' ? '当前没有待办任务' : '近 7 天没有已完成的任务' }}</div>
      <TaskUpdatePopover v-for="t in todoRows" :key="t.id" :task="t" @open="openTask(t.id)">
        <div class="task-row qrow" @click="openTask(t.id)">
          <el-tag :type="TASK_STATUS[t.status]?.type" size="small">{{ TASK_STATUS[t.status]?.label }}</el-tag>
          <span class="task-title ellipsis">{{ t.title }}</span>
          <span class="muted">{{ t.project?.name }}</span>
          <span v-if="t.dueDate" class="due" :class="{ overdue: isOverdue(t.dueDate) }">{{ fmt(t.dueDate, 'MM-DD') }}</span>
          <span v-else-if="todoTab === 'done' && t.completedAt" class="muted done-at">{{ fmt(t.completedAt, 'MM-DD HH:mm') }} 完成</span>
          <!-- 快捷操作：不用进详情就能标完成 / 开始 / 重新打开，以及一步改截止时间 -->
          <span class="task-ops" @click.stop>
            <template v-if="todoTab === 'todo'">
              <el-button v-if="t.status === 'TODO'" text size="small" class="op" :loading="busyTask === t.id" @click="quickStatus(t, 'IN_PROGRESS')">开始</el-button>
              <el-button
                type="success"
                size="small"
                round
                class="op-done"
                :loading="busyTask === t.id"
                title="直接标记为已完成"
                @click="quickStatus(t, 'DONE')"
              >✓ 完成</el-button>
            </template>
            <el-button v-else text size="small" class="op" :loading="busyTask === t.id" @click="quickStatus(t, 'IN_PROGRESS')">重新打开</el-button>
            <el-dropdown trigger="click" @command="(v: string) => quickDue(t, v)">
              <el-button text type="primary" size="small" class="op" :disabled="busyTask === t.id">
                改期<el-icon :size="10"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <li class="op-tip">{{ t.dueDate ? `当前截止：${fmt(t.dueDate, 'YYYY-MM-DD HH:mm')}` : '当前没有截止时间' }}</li>
                  <el-dropdown-item v-for="o in DUE_OPTIONS" :key="o.key" :command="o.key">{{ o.label }}</el-dropdown-item>
                  <el-dropdown-item v-if="t.dueDate" divided command="clear">清除截止时间</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </span>
        </div>
      </TaskUpdatePopover>
      <div v-if="todoTab === 'todo' && my.hidden" class="muted todo-hidden">另有 {{ my.hidden }} 条任务在已放进回收站的项目里，不计入待办（恢复项目后可见）</div>
    </div>
    </div>
    <!-- /home-grid -->

    <!-- 底部备案号：点击跳转工信部备案管理系统 -->
    <footer class="site-beian">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026081809号-2</a>
    </footer>

    <!-- 公告详情 -->
    <el-dialog v-model="detailVisible" :title="current?.title" width="min(94vw, 640px)">
      <div class="announce-meta muted">
        {{ current?.author?.name }} · {{ fmt(current?.createdAt, 'YYYY-MM-DD HH:mm') }}
        <el-tag v-if="current?.pinned" type="danger" size="small">置顶</el-tag>
      </div>
      <MarkdownView :content="current?.content || ''" />
    </el-dialog>

    <!-- 发布公告 -->
    <el-dialog v-model="showCreate" title="发布公告" width="min(94vw, 560px)">
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" maxlength="100" placeholder="公告标题" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="createForm.content" type="textarea" :rows="6" placeholder="支持 Markdown 语法" />
        </el-form-item>
        <el-form-item label="有效期至（留空不自动过期）">
          <el-date-picker
            v-model="createForm.expiresAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="createForm.pinned">置顶公告</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">发布</el-button>
      </template>
    </el-dialog>

    <!-- 使用体验反馈提交弹窗 -->
    <el-dialog v-model="fbVisible" title="使用体验反馈" width="min(94vw, 560px)">
      <el-input
        v-model="fbText"
        type="textarea"
        :rows="5"
        maxlength="2000"
        show-word-limit
        placeholder="说说你在使用中的问题、建议或想要的新功能…"
      />
      <div class="muted fb-tip">反馈会自动同步到公司全员群，团队会跟进处理（受理后会在此标记）。</div>
      <template #footer>
        <el-button @click="fbVisible = false">取消</el-button>
        <el-button type="primary" :loading="fbSending" :disabled="!fbText.trim()" @click="submitFeedback">提交反馈</el-button>
      </template>
    </el-dialog>

    <TaskDetailDrawer v-model="taskDrawer" :task-id="taskId" @changed="load" />

    <!-- 从进展创建/关联任务（首页与详情页共用组件；点击绿色进展条目打开） -->
    <ConvertTaskDialog
      v-model="convertVisible"
      :project="convertProject"
      :update="convertUpdate"
      :source-text="convertSourceText"
      @saved="load"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import { announcementsApi, departmentsApi, intakeApi, projectsApi, reportsApi, tasksApi, meetingsApi, pbcApi, feedbackApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { TASK_PRIORITY, TASK_STATUS, fmt, isUpdateToday, timeAgo, updateDate } from '../utils/format';
import { isTouchDevice, useUpdateMerge } from '../utils/useUpdateMerge';
import MarkdownView from '../components/MarkdownView.vue';
import HomeRankCard from '../components/HomeRankCard.vue';
import HomeRankRotator from '../components/HomeRankRotator.vue';
import ConvertTaskDialog from '../components/ConvertTaskDialog.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';
import TaskUpdatePopover from '../components/TaskUpdatePopover.vue';
import WorkSchedulePanel from '../components/WorkSchedulePanel.vue';

const auth = useAuthStore();
const router = useRouter();

// ---- 顶部统计卡跳转：待办/逾期进入任务页对应筛选（scope），今日进展定位到项目进展区块 ----
const progressSection = ref<HTMLElement | null>(null);
const progressFlash = ref(false);
function goTodo() {
  router.push({ path: '/tasks', query: { scope: 'mine' } });
}
function goOverdue() {
  router.push({ path: '/tasks', query: { scope: 'overdue' } });
}
function goHours() {
  router.push({ path: '/reports', query: { tab: 'hours' } });
}
function goTodayProgress() {
  progressSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  progressFlash.value = true;
  window.setTimeout(() => (progressFlash.value = false), 1600);
}

const announcements = ref<any[]>([]);
const keyTasks = ref<any[]>([]);
// ---- 团队公告里的「会议活动 · 近 3 天」：今天 ± 3 天的会议活动，全员可见 + 登录就能打卡 ----
/** 超过这个条数先折起来，不让公告卡被会议列表顶开 */
const BOARD_FOLD = 6;
const boardMeetings = ref<any[]>([]);
const boardBusy = ref('');
const boardExpanded = ref(false);
/** 排序：先给「现在就能打卡」的，再给「即将开始」的（时间近→远），其余（已打过 / 超 3 天）按开始时间倒序垫底 */
const boardRows = computed(() => {
  const list = (boardMeetings.value || []).slice();
  const rank = (m: any) => (m.canCheckin ? 0 : m.notStarted ? 1 : 2);
  list.sort((a: any, b: any) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const sa = new Date(a.startAt).getTime();
    const sb = new Date(b.startAt).getTime();
    return rank(a) === 1 ? sa - sb : sb - sa;
  });
  return list;
});
const boardShown = computed(() => (boardExpanded.value ? boardRows.value : boardRows.value.slice(0, BOARD_FOLD)));

/** 开始时间的人读标签：今天 / 昨天 / 明天 + 时刻，其余日期直接给 MM-DD */
function boardTimeLabel(m: any): string {
  const d = dayjs(m.startAt);
  const diff = d.startOf('day').diff(dayjs().startOf('day'), 'day');
  const prefix = diff === 0 ? '今天' : diff === -1 ? '昨天' : diff === 1 ? '明天' : d.format('MM-DD');
  return `${prefix} ${d.format('HH:mm')}`;
}

/** 打卡：走与会议页同样的签到口径（只放宽到 3 天），失败提示由 axios 拦截器统一弹出 */
async function doBoardCheckin(m: any) {
  boardBusy.value = m.id;
  try {
    const r: any = await meetingsApi.announceCheckin(m.id);
    ElMessage.success(r?.already ? '你已经打过卡了' : `打卡成功：${m.title}`);
    m.myCheckedIn = true;
    m.canCheckin = false;
    if (!r?.already) m.attendanceCount = (m.attendanceCount || 0) + 1;
  } finally {
    boardBusy.value = '';
  }
}

/** 复制链接：发给同事点开就是这场详情（登录后自动回原页） */
async function copyBoardLink(m: any) {
  const url = `${location.origin}${m.link}`;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('链接已复制');
  } catch {
    ElMessage.warning(`复制失败，请手动复制：${url}`);
  }
}
const myDept = ref<any>(null);
/** 首页「我的部门」卡与快捷入口的跳转目标：
 *  管理员去「管理后台 → 部门管理」（部门菜单已内迁），普通成员仍可进只读的部门页 */
const deptPath = computed(() => (auth.isAdmin ? '/admin?tab=departments' : '/departments'));
/** 卡上只放一个代表部门，其余所属部门（主 ∪ 额外）排成 +N 标签 */
const otherDepts = computed(() => (myDept.value?.departments ?? []).filter((d: any) => d.id !== myDept.value?.id));
const my = ref<{ todo: any[]; done: any[]; overdue: number; hidden: number }>({ todo: [], done: [], overdue: 0, hidden: 0 });
// 顶部工时卡：本人本周/本月/累计（已发布日报 hours 求和），接口失败时保持全 0 不阻断首页
const hoursStat = ref({ weekHours: 0, monthHours: 0, totalHours: 0, weekDays: 0, monthDays: 0, totalDays: 0, firstWorkDay: '' });
const allMeetings = ref<any[]>([]);
const projectUpdates = ref<any[]>([]);
// 首页进展卡片排序：有进展的按最新一条进展的消息时间倒序排前，无进展的保持原顺序沉底（后端按项目 updatedAt 排，进展不 touch 项目）
const sortedUpdates = computed(() => {
  const withU = projectUpdates.value.filter((p: any) => p.updates?.length);
  const noU = projectUpdates.value.filter((p: any) => !p.updates?.length);
  withU.sort((a: any, b: any) => {
    const t = (u: any) => (u && (Date.parse(u.periodEnd) || Date.parse(u.createdAt))) || 0;
    return t(b.updates[0]) - t(a.updates[0]);
  });
  return [...withU, ...noU];
});

// 健康度颜色：>=80 绿、50-79 橙、<50 红（纯数值分档，不依赖 level 字段）
function healthClass(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'health-na';
  if (n >= 80) return 'health-good';
  if (n >= 50) return 'health-warn';
  return 'health-bad';
}

// 待参加会议：未开始且非草稿/已完成/已取消，按开始时间升序
const upcomingMeetings = computed(() => {
  const now = new Date();
  return (allMeetings.value || [])
    .filter((m: any) => m.status !== 'DRAFT' && m.status !== 'DONE' && m.status !== 'CANCELLED' && m.startAt && new Date(m.startAt) >= now)
    .sort((a: any, b: any) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
});

/** 播报条目：跑马灯里滚的短文案 + 悬停下拉的完整内容 + 去处理的入口 */
type BroadcastItem = {
  key: string;
  badge: string;
  text: string;
  title: string;
  detail: string;
  actionLabel?: string;
  to?: { path: string; query?: Record<string, string> };
  anchor?: 'progress';
};
const broadcastPaused = ref(false);
const hoverItem = ref<BroadcastItem | null>(null);
const hoverIdx = ref(-1);
function onBroadcastLeave() {
  broadcastPaused.value = false;
  hoverItem.value = null;
  hoverIdx.value = -1;
}
/** 鼠标一进播报区就暂停，并把指针下方那一条作为“当前内容”弹下拉（不一定正好扫到文字上） */
function onBroadcastEnter(e: MouseEvent) {
  broadcastPaused.value = true;
  if (hoverItem.value) return;
  const wrap = e.currentTarget as HTMLElement;
  const nodes = Array.from(wrap.querySelectorAll<HTMLElement>('.broadcast-item'));
  const hit = nodes.find((n) => {
    const r = n.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right;
  });
  if (!hit) return;
  const idx = nodes.indexOf(hit) % broadcastItems.value.length;
  hoverItem.value = broadcastItems.value[idx] ?? null;
  hoverIdx.value = idx;
}
/** 播报点击：能直开详情（任务/会议）就直开，否则去对应列表；无指向的只提示 */
function goBroadcast(b: BroadcastItem) {
  if (b.anchor === 'progress') {
    goTodayProgress();
    return;
  }
  if (b.to) router.push(b.to);
}

// 首页播报内容：本月待完成任务 / 逾期 / 待参加会议 / 最近会议 / 最近截止
const broadcastItems = computed<BroadcastItem[]>(() => {
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const monthStart = new Date(y, mo, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, mo + 1, 0, 23, 59, 59, 999);
  const todos = my.value.todo || [];
  const monthTodo = todos.filter((t: any) => t.dueDate && new Date(t.dueDate) >= monthStart && new Date(t.dueDate) <= monthEnd);
  const overdueList = todos.filter((t: any) => t.dueDate && new Date(t.dueDate) < now);
  const up = upcomingMeetings.value;
  const items: BroadcastItem[] = [];
  const brief = (arr: any[], n = 3) => {
    if (!arr.length) return '';
    const head = arr.slice(0, n).map((t: any) => t.title).join('、');
    return arr.length > n ? `${head} 等 ${arr.length} 项` : head;
  };

  if (monthTodo.length) {
    items.push({
      key: 'month',
      badge: '📋',
      text: `📋 本月待完成任务 ${monthTodo.length} 项`,
      title: `本月待完成任务 ${monthTodo.length} 项`,
      detail: brief(monthTodo),
      actionLabel: '去任务列表处理',
      to: { path: '/tasks', query: { scope: 'mine' } },
    });
  }
  const overdueCount = overdueList.length || (my.value.overdue || 0);
  if (overdueCount) {
    items.push({
      key: 'overdue',
      badge: '⏰',
      text: `⏰ 已逾期任务 ${overdueCount} 项，请尽快处理`,
      title: `已逾期任务 ${overdueCount} 项`,
      detail: overdueList.length ? brief(overdueList) + '；可以改期，也可以直接标完成' : '点开任务列表查看逾期明细',
      actionLabel: '查看逾期任务',
      to: { path: '/tasks', query: { scope: 'overdue' } },
    });
  }
  if (up.length) {
    items.push({
      key: 'meetings',
      badge: '📅',
      text: `📅 待参加会议 ${up.length} 场`,
      title: `待参加会议 ${up.length} 场`,
      detail: up
        .slice(0, 3)
        .map((m: any) => `${m.title}（${fmt(m.startAt, 'M月D日 HH:mm')}）`)
        .join('；'),
      actionLabel: '去会议列表',
      to: { path: '/meetings' },
    });
    const m0 = up[0];
    items.push({
      key: 'next-meeting',
      badge: '🔜',
      text: `🔜 最近会议：${m0.title}（${fmt(m0.startAt, 'M月D日 HH:mm')}）`,
      title: `最近会议：${m0.title}`,
      detail: `${fmt(m0.startAt, 'M月D日 HH:mm')} 开始${m0.location ? ' · ' + m0.location : ''}`,
      actionLabel: '打开这场会议',
      to: { path: `/meetings/${m0.id}` },
    });
  }
  const soonest = [...todos]
    .filter((t: any) => t.dueDate && new Date(t.dueDate) >= now && new Date(t.dueDate) <= monthEnd)
    .sort((a: any, b: any) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())[0];
  if (soonest) {
    items.push({
      key: 'soonest',
      badge: '📌',
      text: `📌 最近截止：${soonest.title}（${fmt(soonest.dueDate, 'M月D日')}）`,
      title: `最近截止：${soonest.title}`,
      detail: `截止 ${fmt(soonest.dueDate, 'M月D日 HH:mm')}${soonest.project?.name ? ' · ' + soonest.project.name : ''}`,
      actionLabel: '打开这条任务',
      to: { path: '/tasks', query: { open: soonest.id } },
    });
  }
  if (!items.length) {
    items.push({
      key: 'empty',
      badge: '✅',
      text: '✅ 本月暂无待办与临近会议，安心专注工作',
      title: '今天没有紧急事项',
      detail: '本月暂无待办与临近会议，可以专心推进在手项目',
    });
  }
  return items;
});
// 滚动时长随内容量自适应（保持大致恒定速度）
const broadcastDur = computed(() => {
  const total = broadcastItems.value.reduce((n, s) => n + s.text.length, 0);
  return Math.min(70, Math.max(22, Math.round(total * 0.6)));
});

// 底部功能入口：按场景分组，避免十余个入口平铺造成功能区难以辨识
const quickGroups = computed(() => [
  {
    title: '工作台',
    items: [
      { label: '任务', icon: 'List', path: '/tasks', color: '#428bff', bg: '#ecf5ff' },
      { label: '项目', icon: 'FolderOpened', path: '/projects', color: '#1b4fa8', bg: '#ecf5ff' },
      { label: '任务看板', icon: 'Grid', path: '/tasks?tab=board', color: '#428bff', bg: '#ecf5ff' },
      { label: '工作管理', icon: 'Document', path: '/reports', color: '#67c23a', bg: '#f0f9eb' },
      { label: '会议活动', icon: 'ChatDotSquare', path: '/meetings', color: '#1b4fa8', bg: '#ecf5ff' },
    ],
  },
  {
    title: '团队协作',
    items: [
      { label: '部门', icon: 'OfficeBuilding', path: deptPath.value, color: '#67c23a', bg: '#f0f9eb' },
      { label: '复盘', icon: 'RefreshLeft', path: '/retrospectives', color: '#e6a23c', bg: '#fdf6ec' },
      { label: 'SOP', icon: 'Collection', path: '/sops', color: '#e6a23c', bg: '#fdf6ec' },
      { label: '知识库', icon: 'Notebook', path: '/knowledge', color: '#428bff', bg: '#ecf5ff' },
      { label: '行业资讯', icon: 'Promotion', path: '/news', color: '#f56c6c', bg: '#fef0f0' },
      { label: '灵感', icon: 'Sunny', path: '/ideas', color: '#e6a23c', bg: '#fdf6ec' },
    ],
  },
  ...(auth.isAdmin
    ? [
        {
          title: '系统管理',
          items: [
            { label: '管理后台', icon: 'Setting', path: '/admin', color: '#909399', bg: '#f4f4f5' },
            { label: '大模型调用', icon: 'Cpu', path: '/ai-calls', color: '#428bff', bg: '#ecf5ff' },
          ],
        },
      ]
    : []),
]);

const detailVisible = ref(false);
const current = ref<any>(null);
const showCreate = ref(false);
const creating = ref(false);
const createForm = reactive({ title: '', content: '', pinned: false, expiresAt: null as string | null });

const taskDrawer = ref(false);
const taskId = ref<string | null>(null);

// ---- 顶部 AI 录入（文字 + 语音）----
const INTAKE_PRESETS = [
  { value: 'DAILY', label: '日报', icon: 'Document' },
  { value: 'WEEKLY', label: '周报', icon: 'Calendar' },
  { value: 'TASK', label: '任务', icon: 'List' },
  { value: 'IDEA', label: '灵感', icon: 'Sunny' },
];
// 日报工时快捷档位（选完直接跟着录入一起落库，不用录入后再回来改）
const HOUR_OPTIONS = [1, 2, 4, 6, 8];
const CAT_LABEL: Record<string, string> = { DAILY: '日报', WEEKLY: '周报', TASK: '任务', IDEA: '灵感' };
const CAT_TAG: Record<string, string> = { DAILY: 'success', WEEKLY: 'warning', TASK: 'primary', IDEA: '' };
function catLabel(c?: string) {
  return CAT_LABEL[(c || '').toUpperCase()] || '录入';
}
function catTagType(c?: string) {
  return CAT_TAG[(c || '').toUpperCase()] ?? '';
}

// 右侧栏（团队公告 + 全部功能）收起/展开：只影响桌面双栏，手机端右栏本来就排在下面
const sideCollapsed = ref(false);

// 使用体验反馈：顶部「反馈」按钮弹窗，提交后落库并自动同步公司全员群
const fbVisible = ref(false);
const fbText = ref('');
const fbSending = ref(false);
async function submitFeedback() {
  const content = fbText.value.trim();
  if (!content) return;
  fbSending.value = true;
  try {
    const res = await feedbackApi.create(content);
    fbText.value = '';
    fbVisible.value = false;
    ElMessage.success(res?.sent ? '反馈已提交，并同步到公司群' : '反馈已提交');
  } finally {
    fbSending.value = false;
  }
}

const intakeText = ref('');
// 智能录入默认收起（只留一行输入）：预设类别按钮占两行，平时不需要一直占着首屏
const intakeOpen = ref(false);
const intakeCategory = ref<string | null>(null);
const intakeInputRef = ref<any>(null);
const submittingIntake = ref(false);
const undoing = ref(false);
const creatingTask = ref(false);
const intakeResult = ref<any>(null);
const pickedProjectId = ref<string | null>(null);
// 智能录入识别为日报时：直接在结果卡里补/改当日工时（首页也能记工时，不只能靠 AI）
const intakeHours = ref<number | null>(null);
const intakeHoursSaved = ref(false);
const savingIntakeHours = ref(false);
// 录入前就选好的工时档位（1/2/4/6/8），提交日报时自动带上
const intakeHoursPick = ref<number | null>(null);
function pickHours(h: number) {
  intakeHoursPick.value = intakeHoursPick.value === h ? null : h;
}

/** 保存本次录入日报的工时（走 reports.update，只改工时不重跑 AI） */
async function saveIntakeHours() {
  const id = intakeResult.value?.created?.id;
  if (!id) return;
  if (intakeHours.value === null || intakeHours.value === undefined) {
    ElMessage.warning('先填一个工时（小时）');
    return;
  }
  savingIntakeHours.value = true;
  try {
    await reportsApi.update(id, { hours: intakeHours.value });
    intakeHoursSaved.value = true;
    ElMessage.success(`已记录当日工时 ${intakeHours.value} 小时`);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存工时失败');
  } finally {
    savingIntakeHours.value = false;
  }
}

function pickCategory(v: string) {
  intakeCategory.value = intakeCategory.value === v ? null : v;
  focusIntakeInput();
}
function focusIntakeInput() {
  const el = intakeInputRef.value?.textarea || intakeInputRef.value?.$el?.querySelector?.('textarea');
  if (el && typeof el.focus === 'function') el.focus();
}
function notReady() {
  ElMessage.info('更多录入能力即将支持');
}

// Web Speech API（Chrome/Edge 原生支持中文识别，无需后端）
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
const srSupported =
  typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
let recognition: SpeechRecognitionLike | null = null;
let confirmedText = ''; // 语音已确认文本（final）
let interimBuffer = ''; // 语音中间结果（松开时补入）
const listening = ref(false);

function startVoice() {
  if (!srSupported || listening.value) return;
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  recognition = new SR() as SpeechRecognitionLike;
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  confirmedText = intakeText.value; // 以当前输入为起点继续追加
  interimBuffer = '';
  recognition.onresult = (e: any) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) confirmedText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    interimBuffer = interim;
    intakeText.value = confirmedText + interim;
  };
  recognition.onerror = (e: any) => {
    listening.value = false;
    const tips: Record<string, string> = {
      'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试',
      'service-not-allowed': '浏览器/网络不支持语音服务，请改用 Edge 浏览器重试',
      network: '语音服务连接失败（Chrome 在国内网络下不可用），请改用 Edge 浏览器',
      'no-speech': '没有听到声音，请靠近麦克风再说',
      'audio-capture': '未检测到麦克风设备，请检查设备连接',
    };
    ElMessage.warning('语音识别出错：' + (tips[e.error] || e.error));
  };
  recognition.onend = () => {
    listening.value = false;
    // 松开停止时补上未确认的中间文本，避免丢字
    if (interimBuffer) {
      confirmedText += interimBuffer;
      interimBuffer = '';
      intakeText.value = confirmedText;
    }
  };
  recognition.start();
  listening.value = true;
}

function stopVoice() {
  if (listening.value) recognition?.stop();
}

async function submitIntake() {
  const text = intakeText.value.trim();
  if (!text) {
    ElMessage.warning('请先输入或说出内容');
    return;
  }
  submittingIntake.value = true;
  try {
    const res: any = await intakeApi.submit(text, intakeCategory.value || undefined);
    intakeResult.value = res;
    pickedProjectId.value = null;
    // 日报：预填工时（后端漏填会按 0 记，这里回显出来让用户核对）
    intakeHours.value = typeof res?.hours === 'number' ? res.hours : null;
    intakeHoursSaved.value = false;
    // 录入前选了工时档位：直接补写到这条日报上（不再让用户录完再改一次）
    let autoHoursApplied = false;
    if (res?.category === 'DAILY' && res?.created?.id && intakeHoursPick.value) {
      try {
        await reportsApi.update(res.created.id, { hours: intakeHoursPick.value });
        intakeHours.value = intakeHoursPick.value;
        intakeHoursSaved.value = true;
        autoHoursApplied = true;
      } catch {
        // 补写工时失败不影响日报本身，下面会提示用户手动改
      }
    }
    if (res?.category === 'DAILY' && !res?.hours && !autoHoursApplied) {
      ElMessage.warning('日报已提交，但没识别到工时，先按 0 小时记录：请在下方改成实际工时后点保存');
    } else if (autoHoursApplied) {
      ElMessage.success(`${res?.summary || '日报已录入'}，工时 ${intakeHoursPick.value} 小时`);
    } else {
      ElMessage.success(res?.summary || '已录入');
    }
    intakeText.value = '';
    intakeCategory.value = null;
    load(); // 刷新首页数据（任务/进展等）
  } finally {
    submittingIntake.value = false;
  }
}

/** 任务无法匹配项目时：选定归属项目后创建 */
async function confirmTaskWithProject() {
  if (!pickedProjectId.value) {
    ElMessage.warning('请选择归属项目');
    return;
  }
  const pt = intakeResult.value?.pendingTask;
  if (!pt) return;
  creatingTask.value = true;
  try {
    const res: any = await intakeApi.createTask({ projectId: pickedProjectId.value, ...pt });
    intakeResult.value = res;
    ElMessage.success(res?.summary || '任务已创建');
    load();
  } finally {
    creatingTask.value = false;
  }
}

async function undoIntake() {
  const r = intakeResult.value;
  if (!r?.created?.id) return;
  undoing.value = true;
  try {
    const res: any = await intakeApi.undo(r.created.type, r.created.id);
    if (res?.ok) {
      ElMessage.success('已撤销');
      intakeResult.value = null;
      load();
    } else {
      ElMessage.warning(res?.message || '撤销失败');
    }
  } finally {
    undoing.value = false;
  }
}

const greeting = computed(() => {
  const h = dayjs().hour();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});
const today = computed(() => {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${dayjs().format('YYYY年MM月DD日')} ${week[dayjs().day()]}`;
});

function isOverdue(d: string) {
  return dayjs(d).isBefore(dayjs(), 'day');
}

function openTask(id: string) {
  taskId.value = id;
  taskDrawer.value = true;
}

// ---- 我的待办快捷操作：不打开详情就能直接标完成 / 开始 / 重新打开 / 改截止时间 ----
/** 当前页签：待办 or 近 7 天已完成（后端 myTasks 早已返回 done，之前首页没展示，标完成后任务就“消失”了） */
const todoTab = ref<'todo' | 'done'>('todo');
const todoRows = computed(() => (todoTab.value === 'done' ? my.value.done : my.value.todo).slice(0, 8));
/** 当前正在提交的任务 id（同一时间只允许一条，避免连点） */
const busyTask = ref('');

const DUE_OPTIONS = [
  { key: 'today', label: '今天下班前' },
  { key: 'tomorrow', label: '明天' },
  { key: 'friday', label: '本周五' },
  { key: 'week', label: '一周后' },
];

/**
 * 快捷改期：只挑日期，具体时间点沿用原来的（原来没时刻则默认 18:00）
 * 例外：「今天下班前」语义就是下班时刻，固定 18:00，不能沿用一个早上 9 点的旧时刻
 * 本周五：周六 / 周日点的时候本周五已过，自动给到下周周五
 */
function dueTarget(t: any, key: string): string | null {
  if (key === 'clear') return null;
  const base = t.dueDate ? dayjs(t.dueDate) : null;
  const today = dayjs();
  const day =
    key === 'tomorrow'
      ? today.add(1, 'day')
      : key === 'friday'
        ? today.add((5 - today.day() + 7) % 7, 'day')
        : key === 'week'
          ? today.add(7, 'day')
          : today;
  const hour = key === 'today' ? 18 : base ? base.hour() : 18;
  return day.hour(hour).minute(base && key !== 'today' ? base.minute() : 0).second(0).millisecond(0).toISOString();
}

async function quickStatus(t: any, status: 'DONE' | 'IN_PROGRESS') {
  if (busyTask.value) return;
  busyTask.value = t.id;
  try {
    await tasksApi.update(t.id, { status });
    ElMessage.success(status === 'DONE' ? `已完成「${t.title}」` : `已把「${t.title}」改为进行中`);
    await load();
  } finally {
    busyTask.value = '';
  }
}

async function quickDue(t: any, key: string) {
  if (busyTask.value) return;
  const dueDate = dueTarget(t, key);
  busyTask.value = t.id;
  try {
    await tasksApi.update(t.id, { dueDate });
    ElMessage.success(dueDate ? `「${t.title}」截止已改为 ${fmt(dueDate, 'MM-DD HH:mm')}` : `已清除「${t.title}」的截止时间`);
    await load();
  } finally {
    busyTask.value = '';
  }
}

function openAnnouncement(a: any) {
  current.value = a;
  detailVisible.value = true;
}

// ---- 从进展创建/关联任务：点击绿色进展条目弹出（组件在首页与详情页共用） ----
const convertVisible = ref(false);
const convertUpdate = ref<any>(null);
const convertSourceText = ref('');
const convertProject = ref<any>(null);
// 转换弹窗需要完整项目（看板列/成员/负责人），my-updates 只返回轻量对象 → 点击时补拉一次并缓存
const fullProjectCache = new Map<string, any>();

async function openConvertFromProgress(p: any, u: any) {
  // 拖拽/长按拖拽松手后的余波点击：不打开转换弹窗
  if (merge.consumeClick()) return;
  try {
    let full = fullProjectCache.get(p.id);
    if (!full) {
      full = await projectsApi.get(p.id);
      fullProjectCache.set(p.id, full);
    }
    convertProject.value = full;
    convertUpdate.value = u;
    convertSourceText.value = String(u?.content ?? '').trim();
    convertVisible.value = true;
  } catch {
    ElMessage.error('项目详情加载失败，请稍后重试');
  }
}

// ---- 进展合并：同项目内把一条进展拖到另一条上即合并（桌面拖拽 / 移动端长按拖拽） ----
const merge = useUpdateMerge({
  getItem: (key) => {
    for (const p of projectUpdates.value) {
      const hit = (p.updates || []).find((u: any) => u.id === key);
      if (hit) return hit;
    }
    return null;
  },
  onMerged: () => load(),
});

async function create() {
  if (!createForm.title.trim() || !createForm.content.trim()) {
    ElMessage.warning('请填写标题和内容');
    return;
  }
  creating.value = true;
  try {
    await announcementsApi.create(createForm);
    ElMessage.success('公告已发布');
    showCreate.value = false;
    Object.assign(createForm, { title: '', content: '', pinned: false, expiresAt: null });
    load();
  } finally {
    creating.value = false;
  }
}

async function load() {
  const [data, myData, updates, deptStatus, meetingsData, hoursData, boardData] = await Promise.all([
    announcementsApi.list({ activeOnly: 'true' }),
    tasksApi.my(),
    projectsApi.myUpdates(),
    departmentsApi.myStatus().catch(() => null),
    meetingsApi.list({ view: 'mine' }).catch(() => []),
    reportsApi.myHours().catch(() => null),
    meetingsApi.announceBoard().catch(() => []),
  ]);
  announcements.value = data.announcements || [];
  keyTasks.value = data.keyTasks || [];
  my.value = myData;
  projectUpdates.value = updates || [];
  myDept.value = deptStatus;
  allMeetings.value = Array.isArray(meetingsData) ? meetingsData : [];
  boardMeetings.value = Array.isArray(boardData) ? boardData : [];
  if (hoursData) hoursStat.value = hoursData;
}

// 首页全公司榜单：最近一次有评分的 PBC 排行 + 一卡多页轮播（工时/日报 × 本周/本月）
const pbcLatest = ref<{ month: string | null; overall: any[] }>({ month: null, overall: [] });
const hoursWeek = ref<{ rows: any[]; label?: string }>({ rows: [] });
const hoursMonth = ref<{ rows: any[]; label?: string }>({ rows: [] });
const reportWeek = ref<{ rows: any[]; label?: string }>({ rows: [] });
const reportMonth = ref<{ month?: string; label?: string; rows: any[] }>({ rows: [] });

function pbcMonthLabel(m: string | null): string {
  if (!m) return '';
  const [y, mo] = m.split('-');
  return y && mo ? `${y} 年 ${Number(mo)} 月` : m;
}
/** 榜单副标题：月份 + 口径说明（默认展示上个月） */
const pbcRankSubtitle = computed(() => {
  const label = pbcMonthLabel(pbcLatest.value.month);
  return label ? `${label} · 按领导复核最终得分` : '上个月（暂无定稿评分）';
});
const pbcRankRows = computed(() =>
  (pbcLatest.value.overall || []).map((e) => ({ rank: e.rank, name: e.name, sub: e.department, value: `${e.leaderTotal} 分` })),
);
/** 工时榜行（周/月共用） */
const hoursRowsOf = (src: { rows?: any[] }) =>
  (src.rows || []).map((e: any) => ({ rank: e.rank, name: e.name, sub: e.departmentName || '', value: `${e.hours} h` }));
/** 日报篇数榜行（周/月共用；已发布日报一篇算 1 篇） */
const countRowsOf = (src: { rows?: any[] }) =>
  (src.rows || []).map((e: any) => ({ rank: e.rank, name: e.name, sub: e.departmentName || '', value: `${e.count} 篇` }));
// 轮播卡四页：工时（本周/本月）+ 日报数（本周/本月），自动切换、悬浮暂停、均支持展开
const rankTabs = computed(() => [
  { key: 'hours-week', label: '本周工时', subtitle: hoursWeek.value.label || '', rows: hoursRowsOf(hoursWeek.value), emptyText: '本周还没有人填报工时' },
  { key: 'hours-month', label: '本月工时', subtitle: hoursMonth.value.label || '', rows: hoursRowsOf(hoursMonth.value), emptyText: '本月还没有人填报工时' },
  { key: 'reports-week', label: '本周日报', subtitle: reportWeek.value.label || '', rows: countRowsOf(reportWeek.value), emptyText: '本周还没有人提交日报' },
  { key: 'reports-month', label: '本月日报', subtitle: reportMonth.value.label || '', rows: countRowsOf(reportMonth.value), emptyText: '本月还没有人提交日报' },
]);
async function loadRanks() {
  const [pbc, hWeek, hMonth, rWeek, rMonth] = await Promise.all([
    pbcApi.latestRanking().catch(() => ({ month: null, overall: [] })),
    reportsApi.hoursRanking({ scope: 'week', all: true }).catch(() => ({ rows: [] })),
    reportsApi.hoursRanking({ scope: 'month', all: true }).catch(() => ({ rows: [] })),
    reportsApi.reportCountRanking({ scope: 'week', all: true }).catch(() => ({ rows: [] })),
    reportsApi.reportCountRanking({ scope: 'month', all: true }).catch(() => ({ rows: [] })),
  ]);
  pbcLatest.value = pbc as any;
  hoursWeek.value = hWeek as any;
  hoursMonth.value = hMonth as any;
  reportWeek.value = rWeek as any;
  reportMonth.value = rMonth as any;
}

onMounted(() => {
  load();
  loadRanks();
});
</script>

<style scoped>
/* 项目进展区块：点击“今日进展”定位时短暂高亮；避开顶部固定导航 */
.progress-section {
  scroll-margin-top: calc(var(--app-header-h) + 8px);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.progress-section.section-flash {
  border-color: var(--app-brand-deep);
  box-shadow: 0 0 0 3px rgba(66, 139, 255, 0.2);
}
/* 首页主网格：手机单列（靠 order 排：待办→录入→播报→重点→进展→公告/入口），桌面左右两栏 */
.home-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.home-grid > * {
  margin-bottom: 0;
}
.side-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.side-col > * {
  margin-bottom: 0;
}
/* 手机端顺序：最高频的待办放最前，其次智能录入；右侧栏（公告+榜单+全部功能）整体排到进展之后 */
.home-grid .todo-card { order: 1; }
.home-grid .intake-card { order: 2; }
.home-grid .key-card { order: 3; }
.home-grid .schedule-card { order: 4; }
.home-grid .progress-section { order: 5; }
.home-grid .side-col { order: 6; }

/* 右侧栏收起按钮：只在桌面宽屏出现（手机端右栏本来就排在下面，不存在“占宽度”问题） */
.grid-tools {
  display: none;
  justify-content: flex-end;
  margin: 0;
}
.side-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid #dbe7fb;
  border-radius: 12px;
  background: #fff;
  color: #4b6b99;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.side-toggle:hover {
  border-color: var(--app-brand);
  color: var(--app-brand);
  background: #f2f7ff;
}
/* 使用体验反馈按钮：与 side-toggle 同族描边胶囊，但不并入仅桌面显示的 grid-tools，手机也能点 */
.fb-btn {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--chip-line, #dbe7fb);
  border-radius: 12px;
  background: #fff;
  color: var(--chip-ink, #4b6b99);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.fb-btn:hover {
  border-color: var(--app-brand, #428bff);
  color: var(--app-brand, #428bff);
  background: #f2f7ff;
}
.fb-tip {
  margin-top: 8px;
  font-size: 12px;
}

/* 顶部智能播报：浅蓝底单一行，内容连续横向匀速滚动（轨道渲染两份实现无缝循环）
   外层 wrap 负责悬停暂停与下拉详情，内层 bar 只负责跑马灯本身 */
/* 播报与「收起右侧」同一行：播报占满剩余宽度，按钮贴最右；手机不显示按钮 */
.broadcast-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.broadcast-row .broadcast-wrap {
  flex: 1 1 auto;
  min-width: 0;
}
.broadcast-wrap {
  position: relative;
  z-index: 20;
}
.broadcast-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: linear-gradient(90deg, #eaf2ff, #f6f9ff);
  border: 1px solid #dbe7fb;
  border-radius: 10px;
  overflow: hidden;
}
.broadcast-tag {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: #428bff;
  border-radius: 6px;
  padding: 2px 8px;
}
.broadcast-viewport {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
}
.broadcast-track {
  display: inline-flex;
  align-items: center;
  animation: broadcast-scroll 24s linear infinite;
  will-change: transform;
}
.broadcast-bar:hover .broadcast-track {
  animation-play-state: paused;
}
.broadcast-seq {
  display: inline-flex;
  align-items: center;
}
.broadcast-item {
  display: inline-block;
  padding: 0 26px;
  font-size: 13px;
  color: #1b3a6b;
  white-space: nowrap;
}
.broadcast-item.actable {
  cursor: pointer;
}
.broadcast-item.actable:hover,
.broadcast-item.hot {
  color: var(--app-brand-deep);
  text-decoration: underline;
  text-underline-offset: 3px;
}
/* 悬停下拉：贴在播报条下方，显示当前这一条的完整内容 + 去处理 */
.broadcast-drop {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #dbe7fb;
  border-radius: 10px;
  box-shadow: 0 10px 26px rgba(18, 62, 134, 0.16);
  z-index: 30;
}
.bd-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bd-badge {
  flex: 0 0 auto;
  font-size: 15px;
  line-height: 1;
}
.bd-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-md);
  color: #17335f;
}
.bd-act {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: none;
  border-radius: 12px;
  background: var(--app-brand-ink);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.bd-act:hover {
  background: var(--app-brand-deep);
}
.bd-detail {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b80;
  word-break: break-all;
}
@keyframes broadcast-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) {
  .broadcast-track { animation: none; }
}

/* 顶部欢迎横幅：深宝蓝渐变，作为首页深色基准块；白色文字保证对比 */
.hero {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #0c2b5e;
  padding: 18px 18px 14px;
  margin-bottom: 14px;
  background: linear-gradient(135deg, #0f3572 0%, #123e86 40%, #1b4fa8 75%, #428bff 100%);
  color: #fff;
  box-shadow: 0 8px 22px rgba(18, 62, 134, 0.28);
}
.hero::before,
.hero::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.hero::before {
  width: 220px;
  height: 220px;
  right: -70px;
  top: -110px;
  background: rgba(255, 255, 255, 0.06);
}
.hero::after {
  width: 140px;
  height: 140px;
  right: 30px;
  bottom: -90px;
  background: rgba(255, 255, 255, 0.04);
}
.hero-main {
  position: relative;
  z-index: 1;
}
.hero-eyebrow {
  font-size: 12px;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.64);
}
.hero-title {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.01em;
  margin-top: 6px;
  color: #fff;
}
.hero-caption {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  margin-top: 6px;
}
.hero-stats {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 0;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.16);
}
.hero-stat {
  flex: 1;
  /* 手机上 6 张卡换行成每行 2 张，不让标签挤断行 */
  min-width: calc(50% - 4px);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 4px 8px;
  margin: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}
.hero-stat:first-child {
  margin-left: -8px;
}
.hero-stat:hover {
  background: rgba(255, 255, 255, 0.09);
}
.hero-stat:active {
  background: rgba(255, 255, 255, 0.15);
}
.hero-stat + .hero-stat {
  border-left: 1px solid rgba(255, 255, 255, 0.18);
  padding-left: 14px;
  margin-left: 6px;
}
/* 手机端 4 张卡按 2×2 折行：每行首卡（奇数位）不要左分隔线 */
@media (max-width: 767.98px) {
  .hero-stat:nth-child(2n + 1) {
    border-left: none;
    padding-left: 8px;
    margin-left: 0;
  }
}
.hero-stat b {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.hero-stat b.warn {
  color: #ffd04b;
}
/* 工时数值单位：小号淡写，不抢数字视觉 */
.hero-stat b i {
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.72;
  margin-left: 1px;
}
.hero-stat span {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: var(--fs-2xs);
  color: rgba(255, 255, 255, 0.78);
}
.hero-stat span :deep(.el-icon) {
  color: rgba(255, 255, 255, 0.55);
}
/* 我的部门卡：已上移到右栏末尾（与榜单同栏），宽度变窄后行内元素靠换行排 */
.dept-card {
  cursor: pointer;
  margin-top: 12px;
}
.dept-extra {
  cursor: pointer;
  margin-left: 0;
}
.dept-line {
  display: flex;
  align-items: center;
  gap: 10px 14px;
  flex-wrap: wrap;
  font-size: 13px;
}
.dept-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dept-chip {
  font-size: 12px;
  color: #4a5a70;
  background: #eef3fb;
  border: 1px solid #dbe5f2;
  border-radius: 999px;
  padding: 2px 10px;
}
.dept-chip b {
  color: #303133;
  font-weight: 600;
}
.dept-desc {
  margin-top: 8px;
  font-size: 13px;
}
.task-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 6px;
  border-bottom: 1px solid #f2f5f9;
  border-radius: 6px;
  cursor: pointer;
}
.task-row:last-child {
  border-bottom: none;
}
.task-row:hover {
  background: #f3f7fc;
}
/* 我的待办行：窄屏放不下时整行换行，快捷操作区靠右不挤压标题 */
.task-row.qrow {
  flex-wrap: wrap;
}
.task-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex: 0 0 auto;
}
.task-ops .op {
  height: 24px;
  padding: 0 7px;
  font-size: 12px;
}
/* 列表里直接标完成：实心绿钮，一眼能看到、一下就点中 */
.task-ops .op-done {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 600;
}
.op-tip {
  list-style: none;
  padding: 3px 12px;
  font-size: 12px;
  color: #909399;
}
.todo-hidden {
  padding: 8px 6px 0;
  font-size: 12px;
  line-height: 1.5;
}
/* 待办 / 近 7 天完成 两个小页签 */
.todo-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.todo-tabs .tt {
  border: 1px solid #e3e8ef;
  background: #fff;
  color: #606266;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.todo-tabs .tt.on {
  border-color: var(--app-brand-ink, #409eff);
  color: var(--app-brand-ink, #409eff);
  background: #f0f6ff;
  font-weight: 600;
}
.done-at {
  font-size: 12px;
}
.task-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: #303133;
}
.due {
  font-size: 12px;
  color: #606266;
  background: #f5f7fa;
  border-radius: 999px;
  padding: 1px 8px;
  flex-shrink: 0;
}
.due.overdue {
  color: #d03050;
  background: #fdeef1;
}
.announce {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 6px;
  border-bottom: 1px solid #f2f5f9;
  border-radius: 6px;
  cursor: pointer;
}
.announce:last-child {
  border-bottom: none;
}
.announce:hover {
  background: #f3f7fc;
}
.pin {
  flex-shrink: 0;
}
.announce-title {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}
.announce-meta {
  margin-bottom: 12px;
}
/* 会议活动 · 近 3 天：自动置顶的公告条目，用小标题 + 细分割线与人工公告区分层次 */
.board-block {
  margin-bottom: 6px;
  padding: 4px 0 6px;
  border-bottom: 1px solid #eef2f7;
}
.board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}
.board-cap {
  font-size: 12px;
  font-weight: 600;
  color: #8a94a6;
  letter-spacing: 0.2px;
}
.board-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 6px;
  border-radius: 6px;
}
.board-row:hover {
  background: #f3f7fc;
}
.board-kind {
  flex-shrink: 0;
}
.board-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}
.board-main .announce-title {
  /* .announce-title 在横排公告里是 flex:1，进到竖排容器里不能让标题把时间行顶走 */
  flex: none;
}
.board-meta {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.board-link {
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
}
.board-link:hover {
  text-decoration: underline;
}
.board-fold {
  width: 100%;
  margin-top: 2px;
  padding: 6px 0;
  border: none;
  background: none;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
}
.board-fold:hover {
  background: #f3f7fc;
  border-radius: 6px;
}
/* 全部功能：分组展示，图标用淡色圆角底，便于快速区分功能区 */
.entries-card .page-title {
  margin-bottom: 14px;
}
.entry-group + .entry-group {
  margin-top: 14px;
}
.entry-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-brand-ink);
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  padding-left: 8px;
  border-left: 2px solid var(--app-brand);
  line-height: 1.2;
}
.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.quick {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px 4px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.quick:hover {
  border-color: #9dc0f0;
  box-shadow: 0 4px 12px rgba(66, 139, 255, 0.14);
}
.quick:active {
  transform: scale(0.97);
  background: #e9f1fe;
}
.quick-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.quick-label {
  font-size: 12px;
  color: #303133;
  line-height: 1;
  white-space: nowrap;
}
.empty {
  padding: 16px 4px;
  color: #7b8798;
}
.voice-tip {
  font-size: 12px;
  flex: 1;
}
.listening {
  color: #f56c6c;
  font-weight: 600;
}
.voice-pulse {
  animation: voicePulse 1.2s ease-in-out infinite;
}
@keyframes voicePulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.5);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(245, 108, 108, 0);
  }
}
.progress-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.progress-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.progress-card:hover {
  border-color: #9dc0f0;
  box-shadow: 0 6px 18px rgba(66, 139, 255, 0.14);
}
.progress-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
/* 完成度/健康度：大字号百分比，中间分隔线 */
.progress-metrics {
  display: flex;
  align-items: stretch;
  margin: 6px 0 10px;
}
.progress-metrics .metric {
  flex: 1;
  display: flex;
  flex-direction: column;
  line-height: 1.1;
}
.progress-metrics .metric + .metric {
  border-left: 1px solid #eef1f6;
  margin-left: 16px;
  padding-left: 16px;
}
.progress-metrics .metric-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 3px;
}
.progress-metrics .metric-num {
  font-size: var(--fs-num);
  font-weight: 700;
  color: var(--app-heading);
  font-variant-numeric: tabular-nums;
}
.progress-metrics .metric-num i {
  font-style: normal;
  font-size: 13px;
  font-weight: 600;
  margin-left: 1px;
}
.metric-num.health-good {
  color: #67c23a;
}
.metric-num.health-warn {
  color: #e6a23c;
}
.metric-num.health-bad {
  color: #f56c6c;
}
.metric-num.health-na {
  color: #c0c4cc;
}
.progress-head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.proj-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}
.upd-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
}
/* 进展条目：前缀为消息日（简写加粗），文本为 AI 浓缩结论，绿色显示 */
.upd-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: #529b2e;
  border-radius: 6px;
  padding: 4px 8px;
  margin: 0 -8px;
  cursor: pointer;
}
.upd-item:hover {
  background: #f0f9eb;
}
.upd-item:active {
  background: #e6f4dd;
}
.upd-item .upd-date {
  font-size: var(--fs-2xs);
  font-weight: 600;
  flex-shrink: 0;
  color: #529b2e;
  background: #f0f9eb;
  border-radius: 4px;
  padding: 0 5px;
}
.upd-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 当天（消息日为今天）的进展条目：加深绿 + 浅绿底高亮 */
.upd-item.fresh {
  background: #f0f9eb;
  color: #2f7d2a;
}
.upd-item.fresh:hover {
  background: #e1f3d8;
}
.upd-item.fresh:active {
  background: #d3edd0;
}
.upd-item.fresh .upd-date {
  color: #3d8a37;
  background: #e1f3d8;
}
/* 已转为任务的进展：蓝色显示以示区别（覆盖当天高亮的绿色） */
.upd-item.converted {
  color: #1e5fc8;
}
.upd-item.converted:hover {
  background: #eaf2ff;
}
.upd-item.converted:active {
  background: #dcebff;
}
.upd-item.converted .upd-date {
  color: #1e5fc8;
  background: rgba(66, 139, 255, 0.16);
}
.upd-conv {
  flex-shrink: 0;
  font-size: var(--fs-2xs);
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--app-brand);
  background: rgba(66, 139, 255, 0.12);
}
/* 拖拽合并：源条目半透明，命中目标高亮 */
.upd-item.dragging {
  opacity: 0.45;
}
.upd-item.drag-over {
  background: rgba(66, 139, 255, 0.16);
  outline: 1px dashed var(--app-brand);
}
.progress-empty {
  font-size: 12px;
  padding: 6px 0;
}
/* 顶部 AI 录入框 */
.intake-card {
  padding-bottom: 16px;
  background: #fff;
}
.intake-head {
  margin-bottom: 14px;
  gap: 8px;
  flex-wrap: wrap;
}
/* 展开/收起预设类别：收起时只留右下角一个小开关，点输入框也会自动展开 */
.intake-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  margin-left: 4px;
  padding: 2px 8px;
  border: 1px solid #d6e4ff;
  border-radius: 12px;
  background: #f5f8ff;
  color: var(--app-brand);
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.intake-toggle:hover {
  background: #e8f1ff;
}
.intake-toggle.on :deep(.el-icon) {
  transform: rotate(180deg);
}
.intake-toggle :deep(.el-icon) {
  transition: transform 0.15s;
}
.intake-card:not(.is-open) .intake-head {
  margin-bottom: 8px;
}
.intake-sub {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: #7b8798;
}
.intake-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #dcdfe6;
  background: #f5f7fa;
  color: #606266;
  border-radius: 9px;
  padding: 8px 4px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s;
}
.pill :deep(.el-icon) {
  font-size: 14px;
}
.pill:hover {
  border-color: #9dc0f0;
  color: var(--app-brand-ink);
  background: #e9f1fe;
}
.pill.active {
  background: var(--app-brand-ink);
  border-color: var(--app-brand-deep);
  color: #fff;
  box-shadow: 0 2px 8px rgba(18, 62, 134, 0.3);
}
/* 日报工时快捷档位：紧凑胶囊，跟上面的类别胶囊区分开 */
.intake-hours-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0 0 10px;
}
.hours-label {
  flex: 0 0 auto;
  font-size: 12px;
  color: #7b8798;
}
.intake-hours-row .hours-pill {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
}
.hours-tip {
  font-size: var(--fs-2xs);
}
.intake-input :deep(.el-textarea__inner) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px #dcdfe6 inset;
  background: #fbfcfe;
  padding: 10px 12px;
}
.intake-input :deep(.el-textarea__inner:focus) {
  box-shadow: 0 0 0 1px var(--app-brand-deep) inset;
  background: #fff;
}
.intake-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.plus-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid #dcdfe6;
  background: #fff;
  color: #909399;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
.plus-btn:hover {
  border-color: var(--app-brand);
  color: var(--app-brand);
}
.send-btn {
  margin-left: auto;
  flex-shrink: 0;
}
.intake-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef4fb;
  border: 1px solid #dbe5f2;
}
.intake-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.intake-summary {
  font-size: 14px;
  color: #303133;
}
.undo-btn {
  margin-left: auto;
}
.intake-detail {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.6;
}
.intake-hours {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.intake-hours-label {
  font-size: 13px;
  color: #303133;
  font-weight: 600;
}
.intake-hours-tip {
  font-size: 12px;
  line-height: 1.5;
}
.intake-hours-required {
  color: #f56c6c;
  margin-left: 2px;
}
.need-project {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
/* 底部备案号：居中浅灰小字，弱化存在感但始终可达 */
.site-beian {
  text-align: center;
  padding: 2px 0 8px;
  font-size: 12px;
}
.site-beian a {
  color: #9aa5b4;
  text-decoration: none;
}
.site-beian a:hover {
  color: var(--app-brand);
  text-decoration: underline;
}
/* PC 宽屏两栏：左栏（待办/录入/播报/重点/进展）约 62%，右栏（公告/榜单/全部功能）约 38%
   手机和平板保持单列，靠上面的 order 排序；这里改成 grid 后，order 仍然决定左栏内先后 */
@media (min-width: 1024px) {
  .grid-tools {
    display: flex;
  }
  .home-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
    gap: 14px;
    align-items: start;
  }
  /* 收起右侧栏：中间内容占满整行 */
  .home-grid.side-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .home-grid.side-collapsed > .side-col {
    display: none;
  }
  .home-grid > .todo-card,
  .home-grid > .intake-card,
  .home-grid > .broadcast-bar,
  .home-grid > .key-card,
  .home-grid > .progress-section {
    grid-column: 1;
  }
  /* 右栏（公告 + PBC/工时榜 + 全部功能）固定在第 2 列，纵跨整个左栏。
     不再 sticky：右栏内容已高于视口，sticky 会把底部「全部功能」钉在屏幕外滚不到，
     改为随页面自然滚动，底部内容可达 */
  .home-grid > .side-col {
    grid-column: 2;
    grid-row: 1 / span 5;
    gap: 14px;
    align-self: start;
  }
  /* 右栏较窄（约 400px）：榜单行紧凑化，给姓名和部门留出空间 */
  .side-col .rank-card-home :deep(.rank-row) {
    gap: 6px;
    padding: 6px 2px;
    font-size: 13px;
  }
  .side-col .rank-card-home :deep(.rk-no) {
    flex: 0 0 24px;
  }
  .side-col .rank-card-home :deep(.rk-dept) {
    flex: 0 1 40%;
    font-size: var(--fs-2xs);
  }
  .side-col .rank-card-home :deep(.rk-val) {
    min-width: 46px;
  }
}

/* PC 端：横幅左右布局，功能入口每行 6 个 */
@media (min-width: 768px) {
  .hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 32px;
    padding: 22px 24px 18px;
  }
  .hero-stats {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
    flex: 0 0 auto;
    /* 4 张卡（待办/逾期/本周工时/本月工时）固定单行排，不再折行 */
    display: grid;
    grid-template-columns: repeat(4, minmax(92px, max-content));
    gap: 0;
  }
  .hero-stat {
    min-width: 92px;
  }
  /* 单行排：第一张卡不要左分隔线，其余靠 .hero-stat + .hero-stat 的基础规则补线 */
  .hero-stat:first-child {
    border-left: none;
    padding-left: 8px;
    margin-left: -8px;
  }
  .intake-presets {
    max-width: 560px;
  }
  .quick-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 10px;
  }
}
/* PBC 排行卡：整卡可点，直达工作管理 → PBC → 排行榜 */
.pbc-rank-clickable {
  cursor: pointer;
}
.pbc-rank-clickable:hover {
  box-shadow: var(--el-box-shadow-light);
}
</style>
