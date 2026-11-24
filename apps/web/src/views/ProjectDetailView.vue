<template>
  <div class="page">
    <!-- 保密项目且自己未签协议：后端只回锁定壳，整页只出协议遮罩，不渲染任何项目内容 -->
    <div v-if="ndaLocked" class="page-card nda-card">
      <div class="page-title">🔒 保密项目·需先签署保密协议</div>
      <div class="nda-head">
        「{{ project?.name }}」是保密项目。按保密管理要求，项目成员需在线签署《保密协议》后，
        才能查看该项目的任务、进展、文档与文件。
      </div>
      <div class="nda-body">
        <MarkdownView :content="project?.nda?.content || ''" />
      </div>
      <div class="nda-foot">
        <span class="muted">当前协议版本 v{{ project?.nda?.version }} · 签署记录会留存备查</span>
        <div class="nda-actions">
          <el-button size="small" @click="back">返回项目列表</el-button>
          <el-button size="small" type="primary" :loading="signing" @click="signNdaNow">我已阅读并同意签署</el-button>
        </div>
      </div>
    </div>

    <div v-else-if="project" class="detail">
      <!-- 页头 -->
      <div class="detail-head">
        <div class="head-left">
          <el-button text @click="back">
            <el-icon><ArrowLeft /></el-icon>&nbsp;返回
          </el-button>
          <div class="head-title">
            <span class="dot" :style="{ background: project.color || '#428bff' }"></span>
            <span class="title">{{ project.name }}</span>
            <el-tag v-if="project.confidential" size="small" type="danger" effect="dark">🔒 保密</el-tag>
            <el-tag v-if="project.archived" size="small" type="info" effect="dark">已存档·暂停开发</el-tag>
            <el-tag v-if="project.dingtalkGroupName" size="small" type="info" effect="plain">
              {{ project.dingtalkGroupName }}
            </el-tag>
            <el-tag
              v-for="d in project.departments || []"
              :key="d.id"
              size="small"
              type="success"
              effect="plain"
            >
              {{ d.name }}
            </el-tag>
          </div>
          <!-- 页头只保留一行：负责人/成员/介绍已移到概览底部「项目信息」折叠区（默认收起） -->
        </div>
        <div class="head-actions">
          <el-button v-if="canSettings" size="small" @click="openSettings">
            <el-icon><Setting /></el-icon>&nbsp;项目设置
          </el-button>
        </div>
      </div>

      <!-- 审批横幅：PENDING 提示当前审批人，REJECTED 展示驳回意见并提供重提 -->
      <div v-if="project.status === 'PENDING'" class="approval-banner pending">
        <div class="banner-text">
          <el-tag type="warning" effect="dark" size="small">待审批</el-tag>
          <span>当前等待 <b>{{ project.approver?.name || '未指定审批人' }}</b> 审批，提交时间：{{ fmt(project.approvalSubmittedAt, 'YYYY-MM-DD HH:mm') }}</span>
        </div>
        <div v-if="isPrimaryApprover" class="banner-actions">
          <el-button size="small" @click="openCosignDialog">加签</el-button>
          <el-button size="small" type="primary" :loading="approving" @click="openApproveDialog('approve')">批准</el-button>
          <el-button size="small" type="danger" :loading="approving" @click="openApproveDialog('reject')">驳回</el-button>
        </div>
        <div v-else-if="isMeAsOwner" class="banner-actions muted">
          项目创建后已提交审批，审批前仅创建人、审批人与加签人可见
        </div>
      </div>
      <div v-else-if="project.status === 'REJECTED'" class="approval-banner rejected">
        <div class="banner-text">
          <el-tag type="danger" effect="dark" size="small">已驳回</el-tag>
          <span>审批意见：{{ project.approvalNote || '（未填写）' }}</span>
        </div>
        <div v-if="isMeAsOwner" class="banner-actions">
          <el-button size="small" type="primary" @click="openResubmitDialog">修改后重新提交</el-button>
        </div>
      </div>

      <!-- 审批联审：加签人名单与结论（仅待审批且有加签人时展示；主审批人可移除未处理者，加签人可在此给出结论） -->
      <div v-if="project.status === 'PENDING' && (project.coReviews || []).length" class="approval-banner cosign">
        <div class="banner-text cosign-list">
          <el-tag size="small" effect="plain" type="info">加签审批</el-tag>
          <span v-for="c in project.coReviews" :key="c.id" class="cosign-item">
            <b>{{ c.reviewer?.name }}</b>
            <el-tag v-if="c.status === 'APPROVED'" size="small" type="success" effect="plain">已同意</el-tag>
            <el-tag v-else-if="c.status === 'REJECTED'" size="small" type="danger" effect="plain">已驳回</el-tag>
            <el-tag v-else size="small" type="warning" effect="plain">待审批</el-tag>
            <el-button
              v-if="c.status === 'PENDING' && isPrimaryApprover"
              text
              type="danger"
              size="small"
              @click="removeCosigner(c.id)"
            >移除</el-button>
          </span>
          <span v-if="isCoReviewer && !myPendingCosign" class="muted">（你已给出结论）</span>
        </div>
        <div v-if="myPendingCosign" class="banner-actions">
          <el-button size="small" type="primary" :loading="approving" @click="openCosignDecide('APPROVED')">同意</el-button>
          <el-button size="small" type="danger" :loading="approving" @click="openCosignDecide('REJECTED')">驳回</el-button>
        </div>
      </div>

      <!-- 重点板块收进 Tab：整页不再一条长瀑布流，一次只看一组内容（Tab 状态写入 URL 可深链） -->
      <el-tabs v-model="activeTab" class="pd-tabs">
        <el-tab-pane name="overview">
          <template #label>概览</template>
      <!-- 即将召开的会议横幅：一进项目就能看到最近一场会议（点击直达会议详情） -->
      <div v-if="nextMeeting" class="page-card next-meeting-banner" @click="openMeeting(nextMeeting.id)">
        <span class="nm-dot"></span>
        <span class="nm-label">即将召开</span>
        <span class="nm-title">{{ nextMeeting.title }}</span>
        <span class="muted">{{ fmt(nextMeeting.startAt, 'MM-DD HH:mm') }} · {{ nextMeeting.ownerName || '' }}</span>
        <el-button text type="primary" size="small">会议详情 →</el-button>
      </div>
      <div class="page-card rules-card">
        <div class="block-title-row">
          <span class="block-title">项目规则</span>
          <span class="muted rules-meta">{{ rules.length }} 条 · 应阅 {{ roster?.total ?? membersWithOwner.length }} 人</span>
          <span class="rules-ops">
            <el-button v-if="canPublishRule" text type="primary" size="small" @click="openRuleDialog(null)">＋ 发布规则</el-button>
            <el-button text size="small" @click="toggleRoster">{{ rosterOpen ? '收起名单' : '已阅名单' }}</el-button>
          </span>
        </div>

        <div v-if="rosterOpen" class="rules-roster" v-loading="rosterLoading">
          <div class="roster-col">
            <div class="roster-h">已阅 {{ roster?.readCount ?? 0 }} 人</div>
            <span v-for="u in roster?.read || []" :key="u.id" class="roster-chip read">{{ u.name }}</span>
            <span v-if="!roster?.read?.length" class="muted">暂无</span>
          </div>
          <div class="roster-col">
            <div class="roster-h">未阅 {{ (roster?.unread || []).length }} 人</div>
            <span v-for="u in roster?.unread || []" :key="u.id" class="roster-chip unread">{{ u.name }}</span>
            <span v-if="!roster?.unread?.length" class="muted">全部已阅 ✓</span>
          </div>
        </div>

        <div v-if="!rules.length" class="muted rules-empty">
          {{ canPublishRule ? '还没有项目规则，点右上角「＋ 发布规则」写下第一条（成员会收到站内信）' : '负责人还未发布项目规则' }}
        </div>
        <div v-for="r in rules" :key="r.id" class="rule-item">
          <div class="rule-head">
            <span class="rule-title">{{ r.title }}</span>
            <el-tag size="small" :type="r.ackedByMe ? 'success' : 'warning'" effect="plain">
              {{ r.acks.length }}/{{ roster?.total ?? membersWithOwner.length }} 已阅
            </el-tag>
          </div>
          <div class="rule-by muted">
            {{ r.author?.name || '—' }} 发布于 {{ fmt(r.publishedAt, 'YYYY-MM-DD HH:mm') }}
            <template v-if="r.updatedAt"> · 修订于 {{ fmt(r.updatedAt, 'YYYY-MM-DD HH:mm') }}</template>
          </div>
          <div class="rule-body"><MarkdownView :content="r.content" /></div>
          <div class="rule-acks" v-if="r.acks.length">
            <span v-for="a in r.acks" :key="a.id" class="ack-chip" :title="a.note || ''">
              {{ a.name }}<i v-if="a.note">：{{ a.note }}</i>
            </span>
          </div>
          <div class="rule-foot">
            <template v-if="r.ackedByMe">
              <span class="acked-hint">✓ 你已阅<template v-if="myAckNote(r)">：{{ myAckNote(r) }}</template>（已阅不可撤回）</span>
            </template>
            <template v-else>
              <el-input
                v-model="ackNotes[r.id]"
                size="small"
                class="ack-note"
                maxlength="200"
                placeholder="可附一句说明（选填）"
              />
              <el-button size="small" type="primary" :loading="ackingId === r.id" @click="ackRuleNow(r)">我已阅</el-button>
            </template>
            <span class="rule-ops" v-if="canPublishRule">
              <el-button text size="small" @click="openRuleDialog(r)">编辑</el-button>
              <el-button text size="small" type="danger" @click="removeRule(r)">删除</el-button>
            </span>
          </div>
        </div>
      </div>

      <!-- 项目纪要（进度/汇报/备注）：规则旁的轻量信息发布，成员/负责人/管理员均可发，时间倒序可收起 -->
      <div class="page-card notes-card" v-loading="noteLoading">
        <div class="block-title-row">
          <span class="block-title">项目纪要</span>
          <span class="muted rules-meta">{{ notesTotal }} 条</span>
          <span class="rules-ops">
            <el-button v-if="canPostNote" text type="primary" size="small" @click="openNoteDialog(null)">＋ 发布纪要</el-button>
            <el-button text size="small" @click="collapseAllNotes">收起全部</el-button>
          </span>
        </div>
        <!-- 纪要督促条：常规提示；超过 7 天未更新变橙色警示，点名负责人 -->
        <div class="note-nudge" :class="{ stale: noteStaleDays >= 7 }">
          <template v-if="noteStaleDays >= 7">
            ⚠️ 本项目已 {{ noteStaleDays >= 999 ? '长期' : noteStaleDays + ' 天' }}未更新项目纪要。请项目负责人（{{ project?.owner?.name || '组长' }}）组织成员发布纪要——纪要会自动同步到项目钉钉群。
          </template>
          <template v-else>
            📌 请项目负责人每次进来后发布/更新项目纪要（或安排成员撰写），纪要会自动同步到项目钉钉群并通知全体成员。
          </template>
        </div>
        <div class="note-chips">
          <span class="note-chip" :class="{ on: noteFilter === 'ALL' }" @click="noteFilter = 'ALL'">全部 {{ notesTotal }}</span>
          <span
            v-for="k in NOTE_KINDS"
            :key="k.key"
            class="note-chip"
            :class="{ on: noteFilter === k.key }"
            @click="noteFilter = k.key"
          >
            {{ k.label }} {{ noteCounts[k.key] ?? 0 }}
          </span>
        </div>
        <div v-if="!visibleNotes.length" class="muted rules-empty">
          {{ canPostNote ? '还没有纪要，点右上角「＋ 发布纪要」记录第一条' : '项目里还没有纪要' }}
        </div>
        <div v-for="(n, ni) in visibleNotes" :key="n.id" class="note-item" :class="{ open: !!noteExpanded[n.id] }">
          <div class="note-head" @click="toggleNote(n.id)">
            <el-tag size="small" :type="noteKindTag(n.kind)" effect="dark">{{ noteKindLabel(n.kind) }}</el-tag>
            <el-tag v-if="ni === 0 && noteFilter === 'ALL'" size="small" type="danger" effect="light">最新</el-tag>
            <span class="note-title">{{ n.title }}</span>
            <span class="note-caret muted">{{ noteExpanded[n.id] ? '收起 ▴' : '展开 ▾' }}</span>
          </div>
          <div class="rule-by muted">
            {{ n.author?.name || '—' }} 发布于 {{ fmt(n.publishedAt, 'YYYY-MM-DD HH:mm') }}
            <template v-if="n.updatedAt"> · 修订于 {{ fmt(n.updatedAt, 'YYYY-MM-DD HH:mm') }}</template>
          </div>
          <div v-if="noteExpanded[n.id]" class="rule-body"><MarkdownView :content="n.content" /></div>
          <div v-if="noteExpanded[n.id] && n.canManage" class="note-ops">
            <el-button text size="small" @click="openNoteDialog(n)">编辑</el-button>
            <el-button text size="small" type="danger" @click="removeNote(n)">删除</el-button>
          </div>
        </div>
        <div v-if="hiddenNoteCount > 0" class="note-more" @click="noteLimit += 10">展开更早的 {{ hiddenNoteCount }} 条</div>
      </div>

        <div class="detail-grid" v-loading="loading">
        <!-- 主栏：最近进展（后端返回全量，前端本地分页；同项目内可拖拽/长按拖拽到另一条上合并） -->
        <div ref="updatesCardRef" class="page-card">
          <div class="block-title-row">
            <span class="block-title">最近进展</span>
            <span class="muted merge-tip">拖动一条进展到另一条上可合并（移动端长按）</span>
            <el-button text type="primary" size="small" :loading="refreshing" @click="refresh">刷新</el-button>
          </div>
          <template v-if="pagedUpdates.length">
            <div
              v-for="u in pagedUpdates"
              :key="u.id"
              class="update-item"
              :class="{ fresh: isToday(u.createdAt), converted: !!u.taskId, dragging: merge.isDragging(u), 'drag-over': merge.isDragOver(u) }"
              :draggable="!isTouchDevice"
              :data-merge-key="u.id"
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
              <div class="update-head">
                <span class="update-time">{{ updateDate(u) }}</span>
                <el-tag v-if="u.source === 'AI_GROUP'" size="small" type="info" effect="plain">群聊自动总结</el-tag>
                <el-tag v-else-if="u.source === 'MANUAL'" size="small" type="warning" effect="plain">手动记录</el-tag>
                <el-tag v-else-if="u.source === 'DAILY_REPORT'" size="small" type="primary" effect="plain">日报</el-tag>
                <el-tag v-if="u.taskId" class="update-converted" size="small" type="primary" effect="dark" @click.stop="openLinkedTask(u.taskId)">
                  已转为任务
                </el-tag>
                <el-button class="update-convert" text type="primary" size="small" @click="openConvertDialog(u)">
                  ＋ 转为任务
                </el-button>
              </div>
              <MarkdownView class="update-content" :content="u.content" />
            </div>
            <!-- 分页：全量进展本地分页，每页 10 条 -->
            <el-pagination
              v-if="updateTotal > UPDATE_PAGE_SIZE"
              class="update-pager"
              size="small"
              background
              layout="prev, pager, next, total"
              :total="updateTotal"
              :page-size="UPDATE_PAGE_SIZE"
              :current-page="updatePage"
              @current-change="changeUpdatePage"
            />
          </template>
          <div v-else class="muted empty">
            暂无进展总结。每天 12:00 / 17:00 / 22:00 自动抓取钉钉群消息，抓到新消息即自动生成；
            项目负责人可在右侧「项目设置」点「拉取并生成进展总结」立即生成第一份总结。
          </div>
        </div>

        <!-- 侧栏：项目分析 + 时间计划 + 需求文档 + 成员，与最近进展同屏，概览一页看完重点 -->
        <aside class="side">
          <!-- 项目分析卡（完成度 + 健康度 + 风险 + 建议 + 重新分析） -->
          <div class="page-card health-card">
          <div class="block-title-row">
            <span class="block-title">项目分析</span>
            <el-tag v-if="project.healthLevel" :class="['health-badge', healthLevelClass]" size="small" effect="dark">
              {{ healthLevelLabel }}
            </el-tag>
            <span v-else class="muted">尚未分析</span>
            <el-button text type="primary" size="small" :loading="analyzing" @click="analyzeHealth">重新分析</el-button>
          </div>
          <div class="health-progress">
            <span class="muted">完成度</span>
            <el-progress :percentage="project.completionPercent ?? 0" :stroke-width="10" />
          </div>
          <div v-if="project.healthSummary" class="health-summary">{{ project.healthSummary }}</div>
          <div v-if="healthRisks.length" class="health-block">
            <div class="health-block-title">风险</div>
            <ul class="health-list"><li v-for="(r, i) in healthRisks" :key="'r'+i">{{ r }}</li></ul>
          </div>
          <div v-if="healthSuggestions.length" class="health-block">
            <div class="health-block-title">建议</div>
            <ul class="health-list"><li v-for="(s, i) in healthSuggestions" :key="'s'+i">{{ s }}</li></ul>
          </div>
          <div v-if="project.healthAnalyzedAt" class="muted health-meta">分析时间：{{ fmt(project.healthAnalyzedAt, 'YYYY-MM-DD HH:mm') }}</div>
          </div>

          <!-- 时间计划 -->
          <div class="page-card">
            <div class="block-title">时间计划</div>
            <div class="plan-dates muted">
              <span>{{ fmt(project.startDate, 'YYYY-MM-DD') || '未设定' }}</span>
              <span class="plan-arrow">→</span>
              <span>{{ fmt(project.endDate, 'YYYY-MM-DD') || '未设定' }}</span>
              <el-tag v-if="remainingDays != null" size="small" :type="remainingDays < 0 ? 'danger' : remainingDays <= 7 ? 'warning' : 'success'" effect="plain">
                {{ remainingDays < 0 ? `已逾期 ${-remainingDays} 天` : `剩 ${remainingDays} 天` }}
              </el-tag>
            </div>
            <div class="block-title-row">
              <span class="block-title">里程碑</span>
              <el-tag v-if="project.skipMilestone" size="small" type="info" effect="plain">创建人已确认不需要</el-tag>
            </div>
            <div class="milestone-list">
              <div v-if="!(project.milestones || []).length" class="muted" style="padding: 6px 0">{{ project.skipMilestone ? '创建人已确认：本项目确定不需要里程碑' : '暂无里程碑' }}</div>
              <div v-for="ms in project.milestones || []" :key="ms.id" class="milestone-row">
                <el-checkbox :model-value="isMilestoneDone(ms)" :disabled="true" />
                <span class="ms-name">{{ ms.name }}</span>
                <span class="muted ms-date">{{ fmt(ms.dueDate, 'MM-DD') }}</span>
              </div>
            </div>
          </div>

          <!-- 需求文档（审批人必看点：未上传时也展示，附创建人豁免确认标记） -->
          <div class="page-card">
            <div class="block-title-row">
              <span class="block-title">需求文档</span>
              <el-tag v-if="project.skipRequirementDoc" size="small" type="info" effect="plain">创建人已确认不需要</el-tag>
            </div>
            <div v-if="(project.requirementDocIds || []).length" class="muted" style="font-size: 12px; margin-bottom: 4px">共 {{ project.requirementDocIds.length }} 份，已归入项目文档空间</div>
            <div v-else class="muted" style="font-size: 12px">{{ project.skipRequirementDoc ? '创建人已确认：本项目确定不需要需求文档' : '尚未上传需求文档' }}</div>
          </div>
        </aside>
      </div>

      <!-- 项目信息（负责人 / 成员 / 项目介绍）：概览底部一行，默认收起，点击展开 -->
      <div class="page-card info-card">
        <div class="info-toggle" @click="infoOpen = !infoOpen">
          <span class="block-title">项目信息</span>
          <span class="muted info-summary">
            {{ project.owner?.name }}（负责人） · {{ displayMembers.length + 1 }} 名成员 · {{ taskCount }} 个任务
          </span>
          <span class="info-hint muted">{{ infoOpen ? '收起' : '展开' }}</span>
          <el-icon class="info-arrow" :class="{ open: infoOpen }"><ArrowDown /></el-icon>
        </div>
        <div v-show="infoOpen" class="info-body">
          <div class="info-block">
            <div class="block-title">负责人</div>
            <div v-if="project.owner" class="member">
              <el-avatar :size="28" :src="project.owner?.avatar || undefined">{{ project.owner?.name?.slice(0, 1) }}</el-avatar>
              <a class="member-name name-link" title="查看成员画像" @click="$router.push('/members/' + project.owner.id)">{{ project.owner?.name }}</a>
              <el-tag size="small" type="danger" effect="plain">负责人</el-tag>
              <el-icon class="owner-tag"><Crown /></el-icon>
            </div>
            <div v-else class="muted">未设置负责人</div>
          </div>
          <div class="info-block">
            <div class="block-title">成员（{{ displayMembers.length + 1 }}）</div>
            <!-- 负责人身份由 ownerId 表达，不在成员表里；岗位设置/移除/添加等管理操作随成员信息一并收进此处 -->
            <div v-for="m in displayMembers" :key="m.userId" class="member">
              <el-avatar :size="28" :src="m.user?.avatar || undefined">{{ m.user?.name?.slice(0, 1) }}</el-avatar>
              <a class="member-name name-link" title="查看成员画像" @click="$router.push('/members/' + m.userId)">{{ m.user?.name }}</a>
              <el-select
                v-if="canSetPosition"
                :model-value="m.position || ''"
                placeholder="设置岗位"
                size="small"
                clearable
                style="width: 110px"
                @change="(v: any) => setMemberPosition(m.userId, v || null)"
              >
                <el-option v-for="pos in positions" :key="pos" :label="pos" :value="pos" />
              </el-select>
              <span v-else-if="m.position" class="member-pos muted">{{ m.position }}</span>
              <el-button v-if="canManageMember(m.userId)" text type="danger" size="small" @click="removeMember(m.userId)">
                移除
              </el-button>
            </div>
            <div v-if="canAddMember" class="member-add">
              <el-select v-model="newMemberId" placeholder="添加成员" filterable size="small" style="flex: 1">
                <el-option v-for="u in availableUsers" :key="u.id" :label="u.name" :value="u.id" />
              </el-select>
              <el-button size="small" type="primary" :disabled="!newMemberId" @click="addMember">添加</el-button>
            </div>
          </div>
          <div class="info-block">
            <div class="block-title">项目介绍</div>
            <div v-if="project.description" class="info-desc">{{ project.description }}</div>
            <div v-else class="muted">暂无项目介绍</div>
          </div>
        </div>
      </div>
        </el-tab-pane>

<el-tab-pane name="schedule">
        <template #label>排期计划</template>
        <!-- 排期计划：需求评审→开发→测试→联调→上线→验收 等阶段的时间计划（负责人/管理员可编辑） -->
        <ProjectSchedulePanel :project-id="project.id" :can-edit="canManageSchedule" />
      </el-tab-pane>

      <el-tab-pane name="daily">
        <template #label>项目日报</template>
        <!-- 快速写日报入口：与首页快速日报同一条数据（同日多次提交自动合并），写完本项目日报看板立即可见 -->
        <div class="page-card report-entry-card">
          <div class="block-title-row">
            <span class="block-title">快速写日报</span>
            <span class="muted">写完自动进入下方日报看板与统计，无需跳转其他页面</span>
            <el-button type="primary" size="small" @click="openDailyCompose">＋ 写今日日报</el-button>
          </div>
        </div>
        <!-- 项目日报：本项目按日期聚合 / 按人员时间轴 / 工时排行（数据口径与「工作管理-日报看板」一致） -->
      <ProjectDailyPanel
        ref="dailyRef"
        :key="dailyPanelKey"
        v-if="project?.id"
        :project-id="project.id"
        :members="displayMembers"
        :owner="project.owner"
      />
      </el-tab-pane>

      <el-tab-pane name="worktime">
        <template #label>成员实践/培训时间</template>
        <!-- 成员实践/培训时间：本项目成员每周固定的项目实践/培训时段（只读；成员自己在「工作管理 → 我的实践/培训时间」调整） -->
        <ProjectMemberSchedulePanel :members="displayMembers" :owner="project?.owner" />
      </el-tab-pane>

      <el-tab-pane name="tasks">
        <template #label>任务</template>
        <!-- 任务清单：项目下全部任务（含看板列与列表任务），点击行查看详情 -->
      <div class="page-card tasks-card" v-loading="tasksLoading">
        <div class="block-title-row">
          <span class="block-title">任务清单（{{ tasks.length }}）</span>
          <el-button type="primary" size="small" @click="taskFormVisible = true">
            <el-icon><Plus /></el-icon>&nbsp;新建任务
          </el-button>
        </div>
        <!-- 负责人标签筛选：全部 + 每位负责人（含任务数），点击即过滤；再点取消 -->
        <div v-if="tasks.length" class="assignee-filter">
          <span class="af-chip" :class="{ on: taskAssigneeFilter === '' }" @click="taskAssigneeFilter = ''">全部 {{ tasks.length }}</span>
          <span
            v-for="a in taskAssignees"
            :key="a.id"
            class="af-chip"
            :class="{ on: taskAssigneeFilter === a.id }"
            @click="taskAssigneeFilter = taskAssigneeFilter === a.id ? '' : a.id"
          >
            {{ a.name }} ×{{ a.count }}
          </span>
          <span
            v-if="unassignedTaskCount"
            class="af-chip"
            :class="{ on: taskAssigneeFilter === 'NONE' }"
            @click="taskAssigneeFilter = taskAssigneeFilter === 'NONE' ? '' : 'NONE'"
          >
            未指派 ×{{ unassignedTaskCount }}
          </span>
        </div>
        <el-table :data="filteredTasks" size="small" class="tasks-table" @row-click="openTaskDetail">
          <el-table-column label="任务" min-width="220">
            <template #default="{ row }">
              <TaskUpdatePopover :task="row" @open="openTaskDetail(row)">
                <div class="task-cell">
                  <span class="task-cell-title">{{ row.title }}</span>
                  <span v-if="row.tags?.length" class="tag-row">
                    <el-tag v-for="tag in row.tags.slice(0, 2)" :key="tag.id" size="small" type="info" effect="plain">{{ tag.name }}</el-tag>
                  </span>
                </div>
              </TaskUpdatePopover>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="86">
            <template #default="{ row }">
              <el-tag :type="TASK_STATUS[row.status]?.type" size="small">{{ TASK_STATUS[row.status]?.label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="优先级" width="76">
            <template #default="{ row }">
              <el-tag :type="TASK_PRIORITY[row.priority]?.type" size="small" effect="plain">{{ TASK_PRIORITY[row.priority]?.label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="负责人" width="96">
            <template #default="{ row }">
              <span :class="{ muted: !row.assignee }">{{ row.assignee?.name || '未指派' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="进度" width="140">
            <template #default="{ row }">
              <div class="progress-cell">
                <el-progress :percentage="row.progress ?? 0" :stroke-width="6" :show-text="false" />
                <span class="muted">{{ row.progress ?? 0 }}%</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="截止时间" width="104">
            <template #default="{ row }">
              <span v-if="row.dueDate" class="due" :class="{ overdue: isOverdue(row.dueDate) }">{{ fmt(row.dueDate, 'YYYY-MM-DD') }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="最近更新" width="110">
            <template #default="{ row }">
              <span>{{ row.updatedAt ? fmt(row.updatedAt, 'MM-DD HH:mm') : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="64">
            <template #default="{ row }">
              <el-button text type="primary" size="small" @click.stop="openTaskDetail(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!tasks.length && !tasksLoading" class="muted empty">该项目暂无任务，点右上角「新建任务」创建</div>
      </div>
      </el-tab-pane>

      <el-tab-pane v-if="project?.hasHardware" name="hardware">
        <template #label>硬件</template>
        <!-- 硬件：本项目元件清单（名称/型号/说明/状态/保管人/备注）；项目设置开启「硬件资产」后才显示 -->
        <ProjectHardwarePanel
          v-if="project?.id"
          :project-id="project.id"
          :can-manage="canManageSchedule"
          :owner="project?.owner"
          :users="users"
          :fee-visible="auth.isAdmin"
        />
      </el-tab-pane>

      <el-tab-pane v-if="project?.hasGithub" name="github">
        <template #label>GitHub</template>
        <!-- GitHub：本项目仓库信息（名称/地址/可见性/说明/备注）；仅项目成员/负责人/部门负责人/管理员可见，由项目负责人维护 -->
        <ProjectGithubPanel v-if="project?.id" :project-id="project.id" :can-manage="canManageSchedule" />
      </el-tab-pane>

      <el-tab-pane name="meetings">
        <template #label>项目会议</template>
      <!-- 会议周日历：会议按时间落在一周七列的格子里，一眼看清全周安排 -->
      <div class="page-card meetings-card" v-loading="meetingsLoading">
        <div class="block-title-row">
          <span class="block-title">会议日历</span>
          <div class="weekly-ops">
            <el-button-group size="small">
              <el-button @click="shiftCalWeek(-1)">上一周</el-button>
              <el-button :type="calIsThisWeek ? 'primary' : ''" @click="calGoThisWeek">本周</el-button>
              <el-button @click="shiftCalWeek(1)">下一周</el-button>
            </el-button-group>
          </div>
        </div>
        <div class="cal-week">
          <div v-for="c in calCols" :key="c.key" class="cal-col" :class="{ 'is-today': c.isToday }">
            <div class="cal-col-hd" :class="{ today: c.isToday }">{{ c.label }}</div>
            <div class="cal-col-body">
              <div
                v-for="(m, i) in c.meetings"
                :key="m.id + '-' + i"
                class="cal-block"
                :class="{ 'is-done': m.status === 'DONE' }"
                :style="calBlockStyle(m)"
                :title="`${fmt(m.startAt, 'MM-DD HH:mm')} ${m.title}`"
                @click="openMeeting(m.id)"
              >
                <div class="cal-block-t ellipsis">{{ m.title }}</div>
                <div class="cal-block-time">{{ fmt(m.startAt, 'HH:mm') }}–{{ fmt(m.endAt ?? m.startAt, 'HH:mm') }}</div>
              </div>
              <div v-if="!c.meetings.length" class="cal-empty">—</div>
            </div>
          </div>
        </div>
        <div class="muted cal-tip">点击色块查看会议详情；历史会议全量展示，待开会议展示最近 3 场（全部会议在「会议」页查看）</div>
      </div>
      <!-- 项目会议：已开始的会议按日期倒序列出（日期 + 主题），点击打开会议详情；右上角为发起项目会议入口 -->
      <div class="page-card meetings-card" v-loading="meetingsLoading">
        <div class="block-title-row">
          <span class="block-title">项目会议（{{ meetingTotal }}）</span>
          <el-button type="primary" size="small" @click="createProjectMeeting">
            <el-icon><Plus /></el-icon>&nbsp;发起项目会议
          </el-button>
        </div>

        <div v-if="meetingUpcoming.length" class="mt-group">
          <div class="mt-group-h muted">即将召开</div>
          <div v-for="m in meetingUpcoming" :key="m.id" class="mt-row" @click="openMeeting(m.id)">
            <span class="mt-date">{{ fmt(m.startAt, 'MM-DD HH:mm') }}</span>
            <span class="mt-title ellipsis">{{ m.title }}</span>
            <el-tag size="small" :type="MEETING_STATUS[m.status]?.type" effect="plain">{{ MEETING_STATUS[m.status]?.label || m.status }}</el-tag>
            <span class="muted mt-meta">{{ m.ownerName }}</span>
            <span v-if="m.itemCount" class="muted mt-meta">{{ m.itemCount }} 条待办</span>
            <el-button text type="primary" size="small" @click.stop="openMeeting(m.id)">详情</el-button>
          </div>
        </div>

        <div v-if="meetingPast.length" class="mt-group">
          <div class="mt-group-h muted">历史会议</div>
          <div v-for="m in meetingPast" :key="m.id" class="mt-row" @click="openMeeting(m.id)">
            <span class="mt-date">{{ fmt(m.startAt, 'YYYY-MM-DD HH:mm') }}</span>
            <span class="mt-title ellipsis">{{ m.title }}</span>
            <el-tag size="small" :type="MEETING_STATUS[m.status]?.type" effect="plain">{{ MEETING_STATUS[m.status]?.label || m.status }}</el-tag>
            <span class="muted mt-meta">{{ m.ownerName }}</span>
            <span v-if="m.materialReady?.total" class="muted mt-meta">材料 {{ m.materialReady.submitted }}/{{ m.materialReady.total }}</span>
            <span v-if="m.itemCount" class="muted mt-meta">{{ m.itemCount }} 条待办</span>
            <el-tag v-if="m.minutesReady" size="small" type="success" effect="plain">有纪要</el-tag>
            <el-button text type="primary" size="small" @click.stop="openMeeting(m.id)">详情</el-button>
          </div>
        </div>

        <div v-if="!meetingsLoading && !meetingTotal" class="muted empty">
          该项目还没有会议，点右上角「发起项目会议」创建（会自动带上项目成员与项目绑定群）
        </div>
        <div v-else class="muted mt-tip">点击查看会议详情与周报聚合材料；只列出已开始的会议与近 3 场待开会，全部会议在「会议」页查看</div>
      </div>
      </el-tab-pane>

      <el-tab-pane name="weekly">
        <template #label>项目周报</template>
      <!-- 项目周报（F27）：本周成员周报就绪度 + AI 总结摘要 + 进入完整聚合页入口 -->
      <div class="page-card weekly-card" v-loading="weeklyLoading">
        <div class="block-title-row">
          <span class="block-title">项目周报</span>
          <div class="weekly-ops">
            <span v-if="weekly" class="muted weekly-ready">
              就绪 <b :class="weeklyReadinessClass">{{ weekly.readiness.submitted }}/{{ weekly.readiness.total }}</b>
            </span>
            <el-button size="small" text type="primary" :loading="weeklySummarizing" @click="genWeeklySummary">{{ weeklySummary ? '重新总结' : 'AI 总结' }}</el-button>
            <el-button size="small" type="primary" plain @click="openWeeklyCompose">写本周周报</el-button>
            <el-button size="small" type="primary" @click="openWeeklyReport">查看完整项目周报</el-button>
          </div>
        </div>
        <div v-if="weekly" class="muted weekly-week">{{ weekly.weekLabel }}｜{{ weekly.readiness.missing ? weekly.readiness.missing + ' 人本周未交' : '全员已交本周周报' }}</div>
        <div v-if="weeklySummary?.overview" class="weekly-overview">{{ weeklySummary.overview }}</div>
        <ul v-if="weeklySummary?.progress?.length" class="weekly-prog">
          <li v-for="(p, i) in weeklySummary.progress.slice(0, 3)" :key="i">{{ p }}</li>
        </ul>
        <div v-if="weeklyErr" class="muted weekly-err">{{ weeklyErr }}</div>
        <div v-else-if="!weeklySummary" class="muted weekly-tip">点「AI 总结」由 AI 汇总本周全员周报（总览/进展/下周/风险/需关注）；「查看完整项目周报」阅读每人的「姓名·部门·内容」。</div>
      </div>
      <!-- 成员周报卡片墙：按周切换，每张卡片一位成员，点开看全文 -->
      <div class="page-card weekly-card">
        <div class="block-title-row">
          <span class="block-title">成员周报</span>
          <div class="weekly-ops">
            <el-button-group size="small">
              <el-button @click="shiftWeekReport(-1)">上一周</el-button>
              <el-button :type="weekReportIsCurrent ? 'primary' : ''" @click="pickWeekReportToday">本周</el-button>
              <el-button @click="shiftWeekReport(1)">下一周</el-button>
            </el-button-group>
          </div>
        </div>
        <div v-if="weekly" class="muted weekly-week">{{ weekly.weekLabel }}｜就绪 {{ weekly.readiness.submitted }}/{{ weekly.readiness.total }}{{ weekly.readiness.missing ? ` · ${weekly.readiness.missing} 人未交` : '' }}</div>
        <div v-loading="weeklyLoading" class="wreport-grid">
          <div v-for="s in weekly?.sections ?? []" :key="s.userId" class="wreport-card" :class="{ 'is-miss': !s.submitted }" @click="openWReport(s)">
            <div class="wreport-head">
              <span class="wreport-name">{{ s.name }}</span>
              <span class="wreport-tag" :class="'r-' + s.roleTag">{{ wroleCn(s.roleTag) }}</span>
              <span v-if="!s.submitted" class="wreport-miss">未交</span>
            </div>
            <div class="wreport-body">{{ wreportBrief(s.content) }}</div>
          </div>
          <div v-if="!(weekly?.sections ?? []).length" class="muted doc-empty">该周还没有成员提交周报</div>
        </div>
      </div>
      <!-- 本周文档：按周归组的成员上传文档（与文档中心同一数据源，可切历史周次） -->
      <div class="page-card weekly-card">
        <div class="block-title-row">
          <span class="block-title">本周文档（{{ currentWeekKey }}）</span>
          <div class="weekly-ops">
            <el-select v-model="weekDocKey" size="small" style="width: 130px">
              <el-option v-for="w in weekKeys" :key="w" :label="w" :value="w" />
            </el-select>
            <el-button size="small" type="primary" plain @click="goDocCenter">到文件页上传</el-button>
          </div>
        </div>
        <div v-if="!weekDocs.length" class="muted doc-empty">{{ weekDocKey === currentWeekKey ? '本周还没有人上传文档' : '该周没有文档记录' }}</div>
        <div v-for="it in weekDocs" :key="it.kind + it.id" class="doccenter-row">
          <span class="doc-badge" :class="'b-' + badgeOf(it)">{{ badgeText(it) }}</span>
          <div class="doccenter-main" @click="previewDoc(it)">
            <div class="ellipsis doc-name">{{ it.name }}</div>
            <div class="doccenter-meta">{{ it.uploaderName }} · {{ it.updatedAt?.slice(5, 10) }}</div>
          </div>
          <el-button size="small" text type="primary" @click="previewDoc(it)">预览</el-button>
          <el-button v-if="it.kind === 'file'" size="small" text @click="downloadDocFile(it)">下载</el-button>
        </div>
      </div>
      </el-tab-pane>

      <el-tab-pane name="retro" lazy>
        <template #label>项目复盘</template>
        <!-- 项目复盘：轮次（结构化 5 问/一般）+ 成员提交 + AI 汇总 + 管理员定稿结论 -->
        <RetrospectivesView :embedded-project-id="String(route.params.id ?? '')" />
      </el-tab-pane>

      <el-tab-pane name="docs">
        <template #label>项目文件</template>
        <!-- 文件页（扁平化改版）：一行一文件，类型小标签可选可手输，3D 打印格式直接上传（不预览只下载），可替换不可删除 -->
        <div class="page-card">
          <div class="block-title-row">
            <span class="block-title">项目文件</span>
            <el-input
              v-model="docSearch"
              size="small"
              placeholder="搜索文件名…"
              clearable
              style="width: 170px"
            />
            <el-select
              v-model="uploadDocType"
              size="small"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="文件类型标签（可选）"
              style="width: 180px"
            >
              <el-option v-for="t in uploadTypeOptions" :key="t" :label="t" :value="t" />
            </el-select>
            <el-button size="small" @click="docFormVisible = true">+ 新建在线文档</el-button>
            <el-button size="small" type="primary" :loading="weekUploading" @click="fileUploadInput?.click()">上传文件</el-button>
            <el-button size="small" plain @click="weekFileInput?.click()">上传周报文档</el-button>
            <input ref="fileUploadInput" type="file" multiple hidden @change="onFilesPicked(false)" />
            <input ref="weekFileInput" type="file" multiple hidden @change="onFilesPicked(true)" />
            <input ref="replaceFileInput" type="file" hidden @change="onReplacePicked" />
          </div>
          <div v-if="!docCenterFiltered.length" class="muted doc-empty">
            {{ docSearch ? '没有匹配的文件' : '还没有文件，点右上角「上传文件」（支持 STL / OBJ / STEP / 3MF / GLB 等 3D 格式）' }}
          </div>
          <div v-for="it in docCenterFiltered" :key="it.kind + it.id" class="doccenter-row">
            <span class="doc-badge" :class="'b-' + badgeOf(it)">{{ badgeText(it) }}</span>
            <div class="doccenter-main" @click="previewDoc(it)">
              <div class="ellipsis doc-name">{{ it.name }}</div>
              <div class="doccenter-meta">{{ docCenterMeta(it) }}</div>
            </div>
            <el-tag
              v-if="it.kind === 'file'"
              size="small"
              :type="docTypeMeta(it.docType).color"
              effect="plain"
              class="doc-type-tag"
              title="点击修改类型标签"
              @click="openTypeEdit(it)"
            >
              {{ docTypeMeta(it.docType).label }}
            </el-tag>
            <el-tag v-else size="small" type="success" effect="plain" class="doc-type-tag">在线文档</el-tag>
            <el-button v-if="canPreview(it)" size="small" text type="primary" @click="previewDoc(it)">预览</el-button>
            <el-button v-else size="small" text type="primary" @click="downloadDocFile(it)">下载</el-button>
            <el-button v-if="it.kind === 'file'" size="small" text @click="startReplace(it)">替换</el-button>
            <el-button v-else size="small" text @click="openProjectDoc(it)">编辑</el-button>
          </div>
          <div class="muted doc-empty" style="margin-top: 10px">
            类型标签点击可改（预设可选、也可手动输入）；文件不支持删除，同名重新上传即替换为新版本，历史版本可回看下载
          </div>
        </div>
      </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 审批处理弹窗（批准/驳回） -->
    <el-dialog v-model="approveDialogVisible" :title="approveMode === 'approve' ? '批准项目' : '驳回项目'" width="min(92vw, 420px)" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="approveMode === 'approve' ? '审批意见（可选）' : '驳回意见（必填）'">
          <el-input v-model="approveNote" type="textarea" :rows="3" :placeholder="approveMode === 'approve' ? '可选：向创建人留言' : '阐述驳回理由，创建人可修改后重新提交'" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveDialogVisible = false">取消</el-button>
        <el-button :type="approveMode === 'approve' ? 'primary' : 'danger'" :loading="approving" @click="submitApprove">
          {{ approveMode === 'approve' ? '确认批准' : '确认驳回' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 加签弹窗（主审批人/ADMIN 邀请其他人共同审批） -->
    <el-dialog v-model="cosignDialogVisible" title="加签审批人" width="min(92vw, 460px)" append-to-body>
      <el-form label-position="top">
        <el-form-item label="选择加签人（可多选，均同意后项目才生效；任一人驳回即退回修改）">
          <el-select v-model="cosignIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择成员" style="width: 100%">
            <el-option v-for="u in cosignCandidates" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="(project?.coReviews || []).length" class="muted" style="font-size: 12px">
        已加签：{{ (project?.coReviews || []).map((c: any) => `${c.reviewer?.name}（${c.status === 'APPROVED' ? '已同意' : c.status === 'REJECTED' ? '已驳回' : '待审批'}）`).join('、') }}
      </div>
      <template #footer>
        <el-button @click="cosignDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!cosignIds.length" :loading="cosigning" @click="submitCosign">确认加签</el-button>
      </template>
    </el-dialog>

    <!-- 加签人审批结论弹窗 -->
    <el-dialog v-model="cosignDecideVisible" :title="cosignDecideMode === 'APPROVED' ? '同意该项目立项' : '驳回该项目立项'" width="min(92vw, 420px)" append-to-body>
      <el-form label-position="top">
        <el-form-item :label="cosignDecideMode === 'APPROVED' ? '审批意见（可选）' : '驳回意见（必填）'">
          <el-input v-model="cosignDecideNote" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cosignDecideVisible = false">取消</el-button>
        <el-button :type="cosignDecideMode === 'APPROVED' ? 'primary' : 'danger'" :loading="approving" @click="submitCosignDecide">确认</el-button>
      </template>
    </el-dialog>

    <!-- 重提交弹窗（目前仅重命名称/描述，时间计划与需求文档保持现有） -->
    <el-dialog v-model="resubmitDialogVisible" title="修改后重新提交" width="min(92vw, 460px)" append-to-body>
      <el-form label-position="top">
        <el-form-item label="项目名称">
          <el-input v-model="resubmitForm.name" maxlength="50" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="resubmitForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <div class="muted" style="font-size: 12px">提示：需调整时间计划/需求文档/里程碑，请在项目设置与项目文档空间中处理后重试。</div>
      </el-form>
      <template #footer>
        <el-button @click="resubmitDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResubmit">重新提交</el-button>
      </template>
    </el-dialog>

    <!-- 从进展创建/关联任务（首页与详情页共用组件） -->
    <ConvertTaskDialog
      v-model="convertVisible"
      :project="project"
      :update="convertUpdate"
      :source-text="convertSourceText"
      @saved="load"
    />

    <!-- 从进展创建/关联任务弹窗：与 detail / empty 分支平级，置于页面容器内 -->
    <div v-if="!project && !loading" class="muted empty page-empty">
      项目不存在或无权限访问
      <el-button size="small" type="primary" text @click="$router.push('/projects')">返回项目列表</el-button>
    </div>

    <!-- 发布 / 修订项目规则弹窗（仅系统管理员或项目负责人） -->
    <el-dialog
      v-model="ruleDialogVisible"
      :title="ruleEditing ? '修订项目规则' : '发布项目规则'"
      width="min(96vw, 640px)"
      top="6vh"
      append-to-body
      destroy-on-close
    >
      <el-form label-position="top" size="small">
        <el-form-item label="标题">
          <el-input v-model="ruleForm.title" maxlength="60" placeholder="如「每周五 17:00 前提交周报」" />
        </el-form-item>
        <el-form-item label="正文（支持 Markdown）">
          <el-input v-model="ruleForm.content" type="textarea" :rows="10" placeholder="规则正文…" />
        </el-form-item>
        <div v-if="ruleForm.content.trim()" class="rule-preview">
          <div class="muted">预览</div>
          <MarkdownView :content="ruleForm.content" />
        </div>
        <div v-if="ruleEditing" class="muted rule-edit-tip">
          修订不会清空已有已阅记录，也不会重新发送站内信；如需再次提醒，请删旧后重新发布。
        </div>
      </el-form>
      <template #footer>
        <el-button size="small" @click="ruleDialogVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="ruleSaving" @click="saveRule">
          {{ ruleEditing ? '保存修订' : '发布并通知成员' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 发布 / 编辑项目纪要弹窗（项目成员/负责人/管理员均可发；类型必选） -->
    <el-dialog
      v-model="noteDialogVisible"
      :title="noteEditing ? '编辑纪要' : '发布项目纪要'"
      width="min(96vw, 640px)"
      top="6vh"
      append-to-body
      destroy-on-close
    >
      <el-form label-position="top" size="small">
        <el-form-item label="类型">
          <el-radio-group v-model="noteForm.kind">
            <el-radio-button v-for="k in NOTE_KINDS" :key="k.key" :value="k.key">{{ k.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="noteForm.title" maxlength="60" placeholder="如「第三阶段联调完成，进入联测」" />
        </el-form-item>
        <el-form-item label="正文（支持 Markdown）">
          <el-input v-model="noteForm.content" type="textarea" :rows="10" placeholder="纪要正文…" />
        </el-form-item>
        <div v-if="noteForm.content.trim()" class="rule-preview">
          <div class="muted">预览</div>
          <MarkdownView :content="noteForm.content" />
        </div>
      </el-form>
      <template #footer>
        <el-button size="small" @click="noteDialogVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="noteSaving" @click="saveNote">
          {{ noteEditing ? '保存修改' : '发布' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 项目设置弹窗（管理员 / 项目负责人 / 关联部门负责人）：名称、主题色、群关联、定时与频率、立即发送、存档、转让、删除 -->
    <el-dialog v-model="settingsVisible" title="项目设置" width="min(96vw, 620px)" top="6vh" append-to-body destroy-on-close>
      <el-form label-position="top" size="small">
        <el-form-item label="项目名称">
          <el-input v-model="editForm.name" maxlength="50" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="主题色">
          <el-color-picker v-model="editForm.color" />
        </el-form-item>
        <!-- 保密开关仅系统管理员可见可改（后端 PUT /projects/:id/confidential 也只收 ADMIN） -->
        <el-form-item v-if="auth.isAdmin" label="保密项目">
          <div class="digest-switch">
            <el-switch v-model="editForm.confidential" />
            <span class="muted">
              开启后：仅已在线签署保密协议的项目成员可查看本项目内容（关联部门负责人不再默认可见），
              首页不再展示其进展，每日进展不再群发到钉钉群；系统管理员照常可见，但每次查看会写入访问留痕。
            </span>
          </div>
        </el-form-item>
        <el-form-item label="主要关联部门（可多个；关联部门负责人可查看本项目文档）">
          <el-select v-model="editForm.departmentIds" multiple collapse-tags placeholder="未关联部门" style="width: 100%">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联钉钉群（AI 从此群自动总结项目进展）">
          <div class="group-resolve">
            <el-input
              v-model="editForm.dingtalkGroupName"
              placeholder="填写钉钉群名称"
              clearable
              :disabled="!!editForm.dingtalkConversationId"
            >
              <template #append>
                <el-button :loading="resolvingEdit" @click="resolveGroup">验证并关联</el-button>
              </template>
            </el-input>
          </div>
          <div v-if="editForm.dingtalkConversationId" class="muted group-hint">
            已关联：{{ editForm.dingtalkGroupName }}
            <el-link type="danger" @click="unlinkGroup">取消关联</el-link>
          </div>
          <div v-else class="muted group-hint">填写群名并验证，群存在才可关联；请确认 dws 账号/机器人已在该群</div>
        </el-form-item>
        <el-form-item label="定时发送进展到本群">
          <div class="digest-switch">
            <el-switch v-model="editForm.dailyDigestEnabled" />
            <span class="muted">开启后按下方时间与频率，自动把最近 2 天进展发到该项目群（发给杨力的私聊汇总不受影响）</span>
          </div>
          <div class="digest-sched">
            <span class="sched-lab">发送时间</span>
            <el-time-picker
              v-model="editForm.digestTime"
              format="HH:mm"
              value-format="HH:mm"
              placeholder="20:00"
              style="width: 120px"
              :disabled="!editForm.dailyDigestEnabled"
            />
            <span class="sched-lab">频率</span>
            <el-select v-model="editForm.digestEveryDays" style="width: 140px" :disabled="!editForm.dailyDigestEnabled">
              <el-option label="每天一次" :value="1" />
              <el-option label="每 2 天一次" :value="2" />
              <el-option label="每 3 天一次" :value="3" />
              <el-option label="每 5 天一次" :value="5" />
              <el-option label="每 7 天（每周）" :value="7" />
            </el-select>
          </div>
          <div class="muted group-hint">到达设定时间后的 15 分钟内自动发送；同一天最多发送一次。修改后需点“保存设置”。</div>
        </el-form-item>
        <el-form-item label="项目存档">
          <div class="digest-switch">
            <el-switch v-model="editForm.archived" />
            <span class="muted">存档即暂停开发：项目不再显示在首页与项目列表，也不再自动总结进展/发送日报；可在「项目 - 已存档」中随时恢复开发</span>
          </div>
        </el-form-item>
        <el-form-item label="硬件资产">
          <div class="digest-switch">
            <el-switch v-model="editForm.hasHardware" />
            <span class="muted">每个项目默认开启。开启后详情页出现「硬件」TAB，可登记本项目元件（名称 / 型号 / 说明 / 状态 / 保管人 / 备注）；保管人默认为项目组长，状态含采购中、待采购、已采购待领取、已分配、已归还</span>
          </div>
        </el-form-item>
        <el-form-item label="GitHub 信息">
          <div class="digest-switch">
            <el-switch v-model="editForm.hasGithub" />
            <span class="muted">每个项目默认开启。开启后详情页出现「GitHub」TAB，由项目负责人维护仓库信息（名称 / 地址 / 可见性 / 说明 / 备注）；仅项目成员、负责人、部门负责人与系统管理员可见</span>
          </div>
        </el-form-item>
        <el-form-item label="转让项目负责人（原负责人自动降为普通成员）">
          <div class="transfer-owner">
            <el-select v-model="transferUserId" placeholder="选择新负责人" filterable size="small" style="flex: 1">
              <el-option v-for="m in transferCandidates" :key="m.userId" :label="m.user?.name" :value="m.userId" />
            </el-select>
            <el-button size="small" type="warning" :disabled="!transferUserId" @click="transferOwner">转让</el-button>
          </div>
        </el-form-item>
      </el-form>
      <div class="settings-actions">
        <el-button type="primary" size="small" :loading="saving" @click="saveSettings">保存设置</el-button>
        <el-button size="small" type="warning" :loading="sendingNow" :disabled="!editForm.dingtalkConversationId" @click="sendDigestNow">立即发送到群</el-button>
        <el-dropdown :disabled="!editForm.dingtalkConversationId" @command="(d: string) => summarizeFlow(Number(d))">
          <el-button size="small" type="success" :loading="summarizing" :disabled="!editForm.dingtalkConversationId">
            拉取并生成进展总结
            <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="2">拉取最近 2 天（默认）</el-dropdown-item>
              <el-dropdown-item command="7">拉取最近 1 周</el-dropdown-item>
              <el-dropdown-item command="30">拉取最近 1 个月</el-dropdown-item>
              <el-dropdown-item command="90">拉取最近 3 个月</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <!-- 危险操作：仅系统管理员可删除项目（移入回收站） -->
      <div v-if="auth.isAdmin" class="danger-zone">
        <el-button type="danger" plain size="small" :loading="deleting" @click="deleteProject">删除项目（移入回收站）</el-button>
        <span class="muted">仅管理员可见；项目将从列表/首页移除并放入回收站，可在「项目 - 回收站」恢复或彻底删除</span>
      </div>
    </el-dialog>

    <!-- 项目文档：上传/详情 -->
    <el-dialog v-model="docFormVisible" title="上传项目文档" width="min(96vw, 640px)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="docForm.title" maxlength="100" placeholder="文档标题" />
        </el-form-item>
        <el-form-item label="文档类型">
          <el-select
            v-model="docForm.docType"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="选择或输入类型（留空为未分类）"
            style="width: 100%"
          >
            <el-option v-for="t in docTypeChoices" :key="t" :label="t" :value="t" />
          </el-select>
          <div class="muted doc-type-hint">产品需求文档 / 硬件清单 / 功能清单 / 技术方案 / 开发提示词 / 接线文档；需要新类型直接输入即可。</div>
        </el-form-item>
        <el-form-item label="内容（支持 Markdown）">
          <el-input v-model="docForm.content" type="textarea" :rows="10" placeholder="# 标题&#10;&#10;正文…" />
        </el-form-item>
        <el-form-item label="附件（可选，任意格式，随文档一起保存）">
          <input ref="docFileInput" type="file" multiple style="display: none" @change="onDocFilesPicked" />
          <el-button size="small" @click="docFileInput?.click()">选择附件</el-button>
          <span v-if="!docFiles.length" class="muted">未选择</span>
          <div v-for="(f, i) in docFiles" :key="i" class="doc-attach-row">
            <span>📎 {{ f.name }}（{{ fmtSize(f.size) }}）</span>
            <el-link type="danger" @click="docFiles.splice(i, 1)">移除</el-link>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="docFormVisible = false">取消</el-button>
        <el-button type="primary" :loading="docSaving" @click="saveProjectDoc">保存</el-button>
      </template>
    </el-dialog>
    <el-drawer v-model="docDetailVisible" :title="currentDoc?.title" size="min(94vw, 640px)">
      <template v-if="currentDoc">
        <div class="muted doc-detail-meta">
          <el-tag v-if="currentDoc.docType" size="small" effect="plain" :type="docTypeMeta(currentDoc.docType).color">
            {{ currentDoc.docType }}
          </el-tag>
          {{ currentDoc.author?.name }} · 更新于 {{ fmt(currentDoc.updatedAt, 'YYYY-MM-DD HH:mm') }} ·
          {{ DOC_VIS_LABEL[currentDoc.visibility] || currentDoc.visibility }}
        </div>
        <MarkdownView :content="currentDoc.content" />
        <div v-if="(currentDoc.attachments || []).length" class="doc-att">
          <div class="block-title">附件（{{ currentDoc.attachments.length }}）</div>
          <div v-for="a in currentDoc.attachments" :key="a.id" class="doc-att-row">
            <span>📎</span>
            <el-link type="primary" @click="downloadAttachment(a)">{{ a.fileName }}</el-link>
            <span class="muted">{{ fmtSize(a.size) }}</span>
          </div>
        </div>
      </template>
    </el-drawer>

    <el-drawer v-model="docSpaceVisible" title="项目文档空间" size="min(96vw, 1000px)" destroy-on-close>
      <DocumentSpace v-if="docSpaceVisible && project" scope="project" :target-id="project.id" />
    </el-drawer>

    <!-- 通用文档预览（PDF/图片/docx/文本/csv，在线文档走 Markdown 渲染） -->
    <DocPreview v-model="docPreviewVisible" :item="docPreviewItem" />

    <!-- 文件类型标签编辑（预设可选 + 手动输入，单选） -->
    <el-dialog v-model="typeEditVisible" title="文件类型标签" width="min(92vw, 380px)" append-to-body>
      <el-select v-model="typeEditValue" filterable allow-create default-first-option clearable placeholder="选择或输入类型" style="width: 100%">
        <el-option v-for="t in uploadTypeOptions" :key="t" :label="t" :value="t" />
      </el-select>
      <div class="muted" style="font-size: 12px; margin-top: 8px">预设可直接选，也可输入自定义类型（12 字以内）</div>
      <template #footer>
        <el-button @click="typeEditVisible = false">取消</el-button>
        <el-button type="primary" :loading="typeSaving" @click="saveTypeEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 快速写日报弹窗：与首页快速日报同一条数据，同日多次提交自动合并 -->
    <el-dialog v-model="dailyComposeVisible" title="写今日日报" width="min(96vw, 560px)" append-to-body destroy-on-close>
      <el-form label-position="top" size="small">
        <el-form-item label="今天做了什么？">
          <el-input
            v-model="dailyForm.rawContent"
            type="textarea"
            :rows="8"
            maxlength="2000"
            show-word-limit
            placeholder="如：完成登录模块联调；修复两个推送 bug；明天处理消息中心剩余用例…"
          />
        </el-form-item>
        <el-form-item label="今日工时（小时，选填；不填沿用 AI 提取/已有工时）">
          <el-input-number v-model="dailyForm.hours" :min="0.5" :max="24" :step="0.5" style="width: 140px" />
        </el-form-item>
        <div class="muted report-tip">提交后自动计入本项目日报看板与工时统计；同一天再次提交会追加合并，不会覆盖。</div>
      </el-form>
      <template #footer>
        <el-button size="small" @click="dailyComposeVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="dailySaving" :disabled="!dailyForm.rawContent.trim()" @click="submitDailyNow">提交日报</el-button>
      </template>
    </el-dialog>

    <!-- 成员周报全文弹窗 -->
    <el-dialog v-model="weekReportVisible" :title="weekReportItem ? `${weekReportItem.name} · 周报` : '周报'" width="min(96vw, 560px)" append-to-body>
      <template v-if="weekReportItem">
        <div class="wreport-meta">
          <span v-if="weekReportItem.departmentName" class="muted">{{ weekReportItem.departmentName }}</span>
          <span class="wreport-tag" :class="'r-' + weekReportItem.roleTag">{{ wroleCn(weekReportItem.roleTag) }}</span>
          <span v-if="weekReportItem.source" class="muted">来源：{{ weekReportItem.source === 'AI' ? 'AI 修正' : '手写' }}</span>
        </div>
        <div class="wreport-full">{{ weekReportItem.content || '（无正文）' }}</div>
      </template>
    </el-dialog>

    <!-- 写本周周报弹窗：三段式；可从本周日报一键生成草稿 -->
    <el-dialog v-model="weeklyComposeVisible" title="写本周周报" width="min(96vw, 640px)" append-to-body destroy-on-close>
      <el-form label-position="top" size="small">
        <el-form-item>
          <template #label>
            <span>周报内容（建议三段式：<b>已完成的工作 / 下周计划 / 需要协调的问题</b>）</span>
            <el-button text type="primary" size="small" :loading="weeklyDraftLoading" @click="genWeeklyDraft">从我的日报生成草稿</el-button>
          </template>
          <el-input
            v-model="weeklyForm.rawContent"
            type="textarea"
            :rows="12"
            maxlength="4000"
            show-word-limit
            placeholder="一、已完成的工作…&#10;二、下周计划…&#10;三、需要协调的问题…"
          />
        </el-form-item>
        <div class="muted report-tip">提交即发布，自动汇集到本项目周报与公司周报；同一周再次提交会追加合并。</div>
      </el-form>
      <template #footer>
        <el-button size="small" @click="weeklyComposeVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="weeklySaving" :disabled="!weeklyForm.rawContent.trim()" @click="submitWeeklyNow">提交周报</el-button>
      </template>
    </el-dialog>

    <TaskFormDialog v-model="taskFormVisible" :default-project-id="project?.id" @saved="load" />
    <TaskDetailDrawer v-model="taskDrawer" :task-id="currentTaskId" @changed="load" />

    <!-- 项目群：右上悬浮按钮（带未读红点）+ 右侧抽屉聊天窗 -->
    <div v-if="project && !ndaLocked" class="pchat-fab" @click="openChat" title="项目群">
      <span class="pchat-fab-ico">#</span>
      <span class="pchat-fab-txt">项目群</span>
      <span v-if="chatUnread > 0" class="pchat-badge">{{ chatUnread > 99 ? '99+' : chatUnread }}</span>
    </div>
    <ProjectChatDrawer v-model:visible="chatVisible" :project-id="String(project?.id ?? '')" :project-name="project?.name ?? ''" @sent="onChatSent" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi, tasksApi, usersApi, departmentsApi, knowledgeApi, filesApi, documentsApi, reportsApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { TASK_PRIORITY, TASK_STATUS, fmt, isToday, updateDate } from '../utils/format';
import { isTouchDevice, useUpdateMerge } from '../utils/useUpdateMerge';
import { docTypeMeta, docTypeOptions } from '../utils/doc-types';
import MarkdownView from '../components/MarkdownView.vue';
import RetrospectivesView from './RetrospectivesView.vue';
import DocumentSpace from '../components/DocumentSpace.vue';
import DocPreview from '../components/DocPreview.vue';
import ProjectChatDrawer from '../components/ProjectChatDrawer.vue';
import ConvertTaskDialog from '../components/ConvertTaskDialog.vue';
import TaskFormDialog from '../components/TaskFormDialog.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';
import TaskUpdatePopover from '../components/TaskUpdatePopover.vue';
import ProjectDailyPanel from '../components/ProjectDailyPanel.vue';
import ProjectSchedulePanel from '../components/ProjectSchedulePanel.vue';
import ProjectMemberSchedulePanel from '../components/ProjectMemberSchedulePanel.vue';
import ProjectHardwarePanel from '../components/ProjectHardwarePanel.vue';
import ProjectGithubPanel from '../components/ProjectGithubPanel.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const project = ref<any>(null);
// 重点板块改由 Tab 分组展示；Tab 状态写入 ?tab= 便于深链（首页/消息里的「项目日报」入口可直接跳到日报 Tab）
const TAB_NAMES = ['overview', 'schedule', 'daily', 'worktime', 'tasks', 'hardware', 'github', 'meetings', 'weekly', 'docs'];
const activeTab = computed({
  get: () => {
    const q = String(route.query.tab ?? '');
    // 「硬件」「GitHub」TAB 仅在项目设置开启后存在，未开启的项目深链回到概览
    const names = TAB_NAMES.filter(
      (n) => (n !== 'hardware' || project.value?.hasHardware) && (n !== 'github' || project.value?.hasGithub),
    );
    return names.includes(q) ? q : 'overview';
  },
  // el-tabs 的 v-model 要能写回 URL，否则点 Tab 只高亮不切内容
  set: (name: string) => setTab(name),
});
function setTab(name: string) {
  router.replace({ query: { ...route.query, tab: name } });
}
// 项目日报面板实例：切 Tab 后不需要再滚动定位，但保留引用便于后续扩展
const dailyRef = ref<any>(null);
const users = ref<any[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const newMemberId = ref('');
const positions = ref<string[]>([]);
const departments = ref<any[]>([]);
const boardCreating = ref(false);
const saving = ref(false);
const summarizing = ref(false);
const resolvingEdit = ref(false);
const transferUserId = ref('');
const deleting = ref(false);
/** 项目设置弹窗开关 + “立即发送到群”进行中标记 */
const settingsVisible = ref(false);
const sendingNow = ref(false);

// ---- 项目会议（需求：项目详情页展示项目会议列表 + 发起入口）----
const meetings = ref<{ past: any[]; upcoming: any[]; total: number }>({ past: [], upcoming: [], total: 0 });
const meetingsLoading = ref(false);
const meetingPast = computed(() => meetings.value.past || []);
const meetingUpcoming = computed(() => meetings.value.upcoming || []);
const meetingTotal = computed(() => meetings.value.total || 0);
// 状态口径与「会议」页一致（DRAFT/SCHEDULED/IN_PROGRESS/MINUTING/DONE）
const MEETING_STATUS: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'danger' | 'success' }> = {
  DRAFT: { label: '未发布', type: 'info' },
  SCHEDULED: { label: '待召开', type: 'primary' },
  IN_PROGRESS: { label: '开会中', type: 'warning' },
  MINUTING: { label: '纪要中', type: 'warning' },
  DONE: { label: '已结束', type: 'success' },
};

/** 项目会议列表（含 extraProjectIds 关联场次的服务端已聚好就绪度与条目数）；失败不阻断项目详情 */
async function loadMeetings() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  meetingsLoading.value = true;
  try {
    const r: any = await projectsApi.meetings(id);
    meetings.value = { past: r?.past || [], upcoming: r?.upcoming || [], total: r?.total || 0 };
  } catch {
    meetings.value = { past: [], upcoming: [], total: 0 };
  } finally {
    meetingsLoading.value = false;
  }
}

/** 打开会议详情：复用 /meetings/:id 深链，会议页会自动弹开详情抽屉 */
function openMeeting(id: string) {
  router.push(`/meetings/${id}`);
}

/** 发起项目会议：带 create=PROJECT + projectId 过去，会议页自动预填项目成员与绑定群 */
function createProjectMeeting() {
  if (!project.value) return;
  router.push(`/meetings?create=PROJECT&projectId=${project.value.id}`);
}

// ---- 会议周日历：past+upcoming 合并按周摆进七列时间格子 ----
const calStart = ref(mondayOfD(dayjs()).format('YYYY-MM-DD'));

function shiftCalWeek(step: number) {
  calStart.value = dayjs(calStart.value).add(step * 7, 'day').format('YYYY-MM-DD');
}

function calGoThisWeek() {
  calStart.value = mondayOfD(dayjs()).format('YYYY-MM-DD');
}

const calIsThisWeek = computed(() => calStart.value === mondayOfD(dayjs()).format('YYYY-MM-DD'));

const calCols = computed(() => {
  const all = [...meetingUpcoming.value, ...meetingPast.value];
  const start = dayjs(calStart.value);
  return Array.from({ length: 7 }, (_, i) => {
    const d = start.add(i, 'day');
    const key = d.format('YYYY-MM-DD');
    const ms = all
      .filter((m: any) => String(m.startAt ?? '').slice(0, 10) === key)
      .sort((a: any, b: any) => String(a.startAt).localeCompare(String(b.startAt)));
    return {
      key,
      label: `周${'一二三四五六日'[i]} ${d.format('MM-DD')}`,
      isToday: key === dayjs().format('YYYY-MM-DD'),
      meetings: ms,
    };
  });
});

/** 色块定位：8:00–20:00 共 12 小时映射为列体高度，按开始/时长换算 top/height */
function calBlockStyle(m: any) {
  const s = dayjs(m.startAt);
  const e = dayjs(m.endAt ?? m.startAt);
  const top = Math.max(0, Math.min(96, ((s.hour() * 60 + s.minute() - 480) / 720) * 100));
  const dur = Math.max(30, e.diff(s, 'minute'));
  const h = Math.max(9, Math.min(100 - top, (dur / 720) * 100));
  return { top: `${top}%`, height: `${h}%` };
}

// ---- 项目周报（需求 6 / F27：项目详情页卡片 + 完整聚合页入口）----
const weekly = ref<any>(null);
const weeklyLoading = ref(false);
const weeklySummarizing = ref(false);
const weeklySummary = ref<any>(null);
const weeklyErr = ref('');
const weeklyReadinessClass = computed(() => {
  const r = weekly.value?.readiness;
  if (!r || !r.total) return '';
  return r.submitted >= r.total ? 'ready-full' : r.submitted === 0 ? 'ready-none' : 'ready-part';
});

/** 本周成员周报就绪度 + 缓存的 AI 总结（失败不阻断详情） */
async function loadWeekly() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  weeklyLoading.value = true;
  try {
    const r: any = await projectsApi.weeklyReport(id, weeklyPeriodStart.value || undefined);
    weekly.value = r;
    weeklySummary.value = r?.summary || null;
    weeklyErr.value = '';
  } catch {
    weekly.value = null;
    weeklySummary.value = null;
  }   finally {
    weeklyLoading.value = false;
  }
}

// ---- 成员周报卡片墙（按周切换） ----
const weeklyPeriodStart = ref('');
const weekReportVisible = ref(false);
const weekReportItem = ref<any>(null);

/** 北京口径的周一：周报以自然周聚合，一切切换都落到周一 */
function mondayOfD(d: dayjs.Dayjs) {
  return d.subtract((d.day() + 6) % 7, 'day');
}

function shiftWeekReport(step: number) {
  const base = weeklyPeriodStart.value ? dayjs(weeklyPeriodStart.value) : mondayOfD(dayjs());
  weeklyPeriodStart.value = base.add(step * 7, 'day').format('YYYY-MM-DD');
  loadWeekly();
}

function pickWeekReportToday() {
  weeklyPeriodStart.value = '';
  loadWeekly();
}

const weekReportIsCurrent = computed(
  () => !weeklyPeriodStart.value || mondayOfD(dayjs(weeklyPeriodStart.value)).format('YYYY-MM-DD') === mondayOfD(dayjs()).format('YYYY-MM-DD'),
);

function wroleCn(tag: string) {
  if (tag === 'DEPT_LEADER') return '部门负责人';
  if (tag === 'PROJ_OWNER') return '项目负责人';
  return '成员';
}

function wreportBrief(s: string) {
  const t = String(s ?? '').replace(/[#*`>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '（未交或无正文）';
  return t.length > 90 ? `${t.slice(0, 90)}…` : t;
}

function openWReport(s: any) {
  weekReportItem.value = s;
  weekReportVisible.value = true;
}

/** 卡片上直接“AI 总结”：强制刷新本周总结（缓存已存则重新读时自动命中） */
async function genWeeklySummary() {
  if (!project.value) return;
  weeklySummarizing.value = true;
  weeklyErr.value = '';
  try {
    const r: any = await projectsApi.weeklySummary(project.value.id, undefined, !!weeklySummary.value);
    if (r?.ok && r.summary) weeklySummary.value = r.summary;
    else weeklyErr.value = r?.reason || 'AI 总结生成失败，可进入完整页重试';
  } catch (e: any) {
    weeklyErr.value = e?.response?.data?.message || 'AI 总结生成失败';
  } finally {
    weeklySummarizing.value = false;
  }
}

function openWeeklyReport() {
  if (!project.value) return;
  router.push(`/projects/${project.value.id}/weekly-report`);
}

// ---- 任务清单 ----
const tasks = ref<any[]>([]);
const tasksLoading = ref(false);
const taskDrawer = ref(false);
const currentTaskId = ref<string | null>(null);
const taskFormVisible = ref(false);

// ---- 任务清单：按负责人标签快速筛选（全部 / 每位负责人 / 未指派） ----
const taskAssigneeFilter = ref('');
const taskAssignees = computed(() => {
  const m = new Map<string, { id: string; name: string; count: number }>();
  for (const t of tasks.value) {
    const a = t.assignee;
    if (!a?.id) continue;
    const cur = m.get(a.id) ?? { id: a.id, name: a.name, count: 0 };
    cur.count++;
    m.set(a.id, cur);
  }
  return [...m.values()].sort((x, y) => y.count - x.count);
});
const unassignedTaskCount = computed(() => tasks.value.filter((t) => !t.assignee?.id).length);
const filteredTasks = computed(() => {
  if (!taskAssigneeFilter.value) return tasks.value;
  if (taskAssigneeFilter.value === 'NONE') return tasks.value.filter((t) => !t.assignee?.id);
  return tasks.value.filter((t) => t.assignee?.id === taskAssigneeFilter.value);
});
const editForm = reactive({ name: '', description: '', color: '#428bff', dingtalkConversationId: '', dingtalkGroupName: '', dailyDigestEnabled: false, digestTime: '20:00', digestEveryDays: 1, archived: false, hasHardware: false, hasGithub: true, departmentIds: [] as string[], confidential: false });

/** 保密项目未签协议：详情接口只回 { locked: 'NDA', nda } 锁定壳 */
const ndaLocked = computed(() => project.value?.locked === 'NDA');
const signing = ref(false);

/** 签署当前版本保密协议（签完重拉详情，遮罩立即消失） */
async function signNdaNow() {
  signing.value = true;
  try {
    await projectsApi.signNda(String(route.params.id ?? ''));
    ElMessage.success('已签署保密协议，现在可以查看项目内容了');
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '签署失败');
  } finally {
    signing.value = false;
  }
}

/** 项目下全部任务数（清单全量，含看板列与列表任务） */
const taskCount = computed(() => tasks.value.length);

// ---- 项目规则与已阅（F5） ----

/** 规则列表（后端随详情一起返，已平化为 { title, content, author, acks[], ackedByMe } ） */
const rules = computed<any[]>(() => project.value?.rules ?? []);

/** 发布/修订/删除：仅系统管理员或项目负责人（后端 assertRuleManager 同口径） */
const canPublishRule = computed(
  () =>
    !!auth.user &&
    (auth.isAdmin ||
      project.value?.ownerId === auth.user.id ||
      (project.value?.members || []).some((m: any) => m.userId === auth.user!.id && m.role === 'OWNER')),
);

/** 应阅名单人数（owner + 成员去重，与后端 ruleAudience 一致） */
const membersWithOwner = computed(() => {
  const p = project.value;
  if (!p) return [] as any[];
  const ids = new Set<string>([p.ownerId, ...(p.members || []).map((m: any) => m.userId)]);
  return [...ids].map((id) => ({ id }));
});

const ruleDialogVisible = ref(false);
const ruleEditing = ref<any>(null);
const ruleSaving = ref(false);
const ruleForm = reactive({ title: '', content: '' });
const ackNotes = reactive<Record<string, string>>({});
const ackingId = ref('');
const roster = ref<any>(null);
const rosterOpen = ref(false);
const rosterLoading = ref(false);

function openRuleDialog(r: any) {
  ruleEditing.value = r;
  ruleForm.title = r?.title ?? '';
  ruleForm.content = r?.content ?? '';
  ruleDialogVisible.value = true;
}

async function saveRule() {
  const title = ruleForm.title.trim();
  const content = ruleForm.content.trim();
  if (!title) {
    ElMessage.warning('请填写规则标题');
    return;
  }
  if (content.length < 5) {
    ElMessage.warning('规则正文至少 5 个字');
    return;
  }
  ruleSaving.value = true;
  try {
    if (ruleEditing.value) {
      await projectsApi.updateRule(ruleEditing.value.id, { title, content });
      ElMessage.success('已保存修订（已阅记录保留）');
    } else {
      const r: any = await projectsApi.publishRule(String(route.params.id ?? ''), { title, content });
      ElMessage.success(`已发布，${r?.notified ?? 0} 位成员收到站内信提醒`);
      roster.value = null; // 新规则会改变未阅名单，下次展开重拉
    }
    ruleDialogVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败');
  } finally {
    ruleSaving.value = false;
  }
}

async function removeRule(r: any) {
  try {
    await ElMessageBox.confirm(`确定删除规则「${r.title}」？成员的回执记录会一并清除。`, '删除规则', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await projectsApi.deleteRule(r.id);
    ElMessage.success('已删除');
    roster.value = null;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '删除失败');
  }
}

/** 从规则的 acks 里找出我自己的说明（已阅后不可改） */
function myAckNote(r: any) {
  const me = (r.acks || []).find((a: any) => a.id === auth.user?.id);
  return me?.note || '';
}

async function ackRuleNow(r: any) {
  ackingId.value = r.id;
  try {
    await projectsApi.ackRule(r.id, (ackNotes[r.id] || '').trim() || undefined);
    ElMessage.success('已记录你的已阅');
    roster.value = null;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '操作失败');
  } finally {
    ackingId.value = '';
  }
}

/** 展开/收起已阅名单（首次展开才拉，删改规则后重置重拉） */
async function toggleRoster() {
  rosterOpen.value = !rosterOpen.value;
  if (!rosterOpen.value || roster.value) return;
  rosterLoading.value = true;
  try {
    roster.value = await projectsApi.ruleRoster(String(route.params.id ?? ''));
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '名单加载失败');
    rosterOpen.value = false;
  } finally {
    rosterLoading.value = false;
  }
}

// ---- 项目纪要（进度/汇报/备注） ----

/** 纪要类型（与后端 NOTE_KINDS 保持一致）；tag 对应 el-tag 颜色 */
const NOTE_KINDS = [
  { key: 'PROGRESS', label: '项目进度', tag: 'primary' },
  { key: 'REPORT', label: '汇报内容', tag: 'success' },
  { key: 'NOTE', label: '项目备注', tag: 'warning' },
] as const;
type NoteFilter = 'ALL' | (typeof NOTE_KINDS)[number]['key'];

function noteKindLabel(k: string) {
  return NOTE_KINDS.find((x) => x.key === k)?.label ?? '项目备注';
}
function noteKindTag(k: string): 'primary' | 'success' | 'warning' {
  return (NOTE_KINDS.find((x) => x.key === k)?.tag ?? 'warning') as 'primary' | 'success' | 'warning';
}

const notesList = ref<any[]>([]);
const noteCounts = ref<Record<string, number>>({});
const noteLoading = ref(false);
const noteFilter = ref<NoteFilter>('ALL');
const noteLimit = ref(3); // 默认只展示最近 3 条，其余折叠
const noteExpanded = reactive<Record<string, boolean>>({});

const notesTotal = computed(() => notesList.value.length);

/** 发布纪要：所有项目成员 + 负责人 + 系统管理员（比规则宽松） */
const canPostNote = computed(
  () =>
    !!auth.user &&
    (auth.isAdmin ||
      project.value?.ownerId === auth.user.id ||
      (project.value?.members || []).some((m: any) => m.userId === auth.user!.id)),
);

const filteredNotes = computed(() =>
  noteFilter.value === 'ALL' ? notesList.value : notesList.value.filter((n) => n.kind === noteFilter.value),
);
const visibleNotes = computed(() => filteredNotes.value.slice(0, noteLimit.value));
const hiddenNoteCount = computed(() => Math.max(0, filteredNotes.value.length - noteLimit.value));

/** 距最近一条纪要的天数（从未写过=9999；仅用于督促条警示） */
const noteStaleDays = computed(() => {
  const last = notesList.value[0]?.publishedAt;
  if (!last) return 9999;
  return Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
});

function toggleNote(id: string) {
  noteExpanded[id] = !noteExpanded[id];
}

/** 收起全部：所有已展开条目收起（重新展开任意一条即可） */
function collapseAllNotes() {
  for (const n of notesList.value) noteExpanded[n.id] = false;
}

/** 拉取纪要列表；默认展开最近 3 条，失败静默不阻断详情 */
async function loadNotes() {
  noteLoading.value = true;
  try {
    const r: any = await projectsApi.listNotes(String(route.params.id ?? ''));
    notesList.value = r?.notes ?? [];
    noteCounts.value = r?.counts ?? {};
    noteLimit.value = 3;
    for (const n of notesList.value) noteExpanded[n.id] = false;
    for (const n of notesList.value.slice(0, 3)) noteExpanded[n.id] = true;
  } catch {
    /* 静默：纪要加载失败不影响项目详情其余部分 */
  } finally {
    noteLoading.value = false;
  }
}

const noteDialogVisible = ref(false);
const noteEditing = ref<any>(null);
const noteSaving = ref(false);
const noteForm = reactive<{ kind: NoteFilter; title: string; content: string }>({ kind: 'PROGRESS', title: '', content: '' });

function openNoteDialog(n: any) {
  noteEditing.value = n;
  noteForm.kind = (n?.kind ?? 'PROGRESS') as NoteFilter;
  noteForm.title = n?.title ?? '';
  noteForm.content = n?.content ?? '';
  noteDialogVisible.value = true;
}

async function saveNote() {
  const title = noteForm.title.trim();
  const content = noteForm.content.trim();
  if (!title) {
    ElMessage.warning('请填写纪要标题');
    return;
  }
  if (content.length < 2) {
    ElMessage.warning('纪要正文太短');
    return;
  }
  noteSaving.value = true;
  try {
    if (noteEditing.value) {
      await projectsApi.updateNote(noteEditing.value.id, { title, content });
      ElMessage.success('已保存修改');
    } else {
      await projectsApi.createNote(String(route.params.id ?? ''), { kind: noteForm.kind, title, content });
      ElMessage.success('纪要已发布');
    }
    noteDialogVisible.value = false;
    await loadNotes();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败');
  } finally {
    noteSaving.value = false;
  }
}

async function removeNote(n: any) {
  try {
    await ElMessageBox.confirm(`确定删除纪要「${n.title}」？`, '删除纪要', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await projectsApi.deleteNote(n.id);
    ElMessage.success('已删除');
    await loadNotes();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '删除失败');
  }
}

// ---- 项目群（右侧抽屉聊天窗 + 未读红点） ----

const chatVisible = ref(false);
const chatUnread = ref(0);

async function loadChatUnread() {
  try {
    const r: any = await projectsApi.chatUnread(String(route.params.id ?? ''));
    chatUnread.value = r?.unread ?? 0;
  } catch {
    /* 静默 */
  }
}

function openChat() {
  chatUnread.value = 0;
  chatVisible.value = true;
}

/** 抽屉里发了新消息/收到新消息后：清红点（打开抽屉时已上报已读） */
function onChatSent() {
  if (chatVisible.value) chatUnread.value = 0;
}

// ---- 一站式工作台：概览会议横幅 + 日报/周报写作入口 ----

/** 最近一场即将召开的会议（loadMeetings 已随详情加载，这里只做展示） */
const nextMeeting = computed(() => meetingUpcoming.value[0] ?? null);

/** 快速写日报 */
const dailyComposeVisible = ref(false);
const dailySaving = ref(false);
const dailyForm = reactive<{ rawContent: string; hours: number | null }>({ rawContent: '', hours: null });
const dailyPanelKey = ref(0); // 提交成功后 +1 强制重挂日报面板，聚合立即更新

function openDailyCompose() {
  dailyForm.rawContent = '';
  dailyForm.hours = null;
  dailyComposeVisible.value = true;
}

async function submitDailyNow() {
  const content = dailyForm.rawContent.trim();
  if (!content) return;
  dailySaving.value = true;
  try {
    await reportsApi.submitDaily(content, dailyForm.hours ?? undefined);
    ElMessage.success('今日日报已提交');
    dailyComposeVisible.value = false;
    dailyPanelKey.value++; // 重新拉取日报看板
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '日报提交失败');
  } finally {
    dailySaving.value = false;
  }
}

/** 写本周周报 */
const weeklyComposeVisible = ref(false);
const weeklySaving = ref(false);
const weeklyDraftLoading = ref(false);
const weeklyForm = reactive<{ rawContent: string }>({ rawContent: '' });

function openWeeklyCompose() {
  weeklyForm.rawContent = '';
  weeklyComposeVisible.value = true;
}

/** 把本周（本项目口径）已提交的日报聚合成三段式草稿（后端返回 done/plan/issue 三段），回填后人工可改 */
async function genWeeklyDraft() {
  weeklyDraftLoading.value = true;
  try {
    const r: any = await reportsApi.weeklyDraft({ projectId: String(route.params.id ?? '') });
    const parts: string[] = [];
    if (r?.done) parts.push(`一、已完成的工作\n${r.done}`);
    if (r?.plan) parts.push(`二、下周计划\n${r.plan}`);
    if (r?.issue) parts.push(`三、需要协调的问题\n${r.issue}`);
    weeklyForm.rawContent = parts.join('\n\n');
    if (!weeklyForm.rawContent) ElMessage.info('本周还没有可聚合的日报，请直接填写');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '草稿生成失败');
  } finally {
    weeklyDraftLoading.value = false;
  }
}

async function submitWeeklyNow() {
  const content = weeklyForm.rawContent.trim();
  if (!content) return;
  weeklySaving.value = true;
  try {
    await reportsApi.submitWeekly(content, []);
    ElMessage.success('本周周报已提交，已计入项目周报就绪度');
    weeklyComposeVisible.value = false;
    loadWeekly(); // 就绪度 n/total 立即更新
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '周报提交失败');
  } finally {
    weeklySaving.value = false;
  }
}

// ---- 进展列表分页（后端已返回全量进展，前端本地分页，默认每页 10 条） ----
const UPDATE_PAGE_SIZE = 10;
const updatePage = ref(1);
const updatesCardRef = ref<HTMLElement | null>(null);

/** 全量进展（按 periodEnd 倒序，最新在前） */
const allUpdates = computed<any[]>(() => project.value?.updates ?? []);
const updateTotal = computed(() => allUpdates.value.length);

/** 当前页进展 */
const pagedUpdates = computed(() => {
  const start = (updatePage.value - 1) * UPDATE_PAGE_SIZE;
  return allUpdates.value.slice(start, start + UPDATE_PAGE_SIZE);
});

/** 翻页：切换页码后把进展卡片滚回顶部，避免停留在页面底部看不到新一页开头 */
function changeUpdatePage(page: number) {
  updatePage.value = page;
  nextTick(() => updatesCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ---- 进展合并：同项目内把一条进展拖到另一条上即合并（桌面拖拽 / 移动端长按拖拽） ----
const merge = useUpdateMerge({
  getItem: (key) => allUpdates.value.find((u: any) => u.id === key) ?? null,
  onMerged: async () => {
    await load();
    // 合并后总条数减少，当前页可能越界，回退到最后一页
    const maxPage = Math.max(1, Math.ceil(allUpdates.value.length / UPDATE_PAGE_SIZE));
    if (updatePage.value > maxPage) updatePage.value = maxPage;
  },
});

/** 成员列表（排除负责人，负责人固定展示在顶部） */
const displayMembers = computed(() =>
  (project.value?.members || []).filter((m: any) => m.userId !== project.value?.ownerId),
);

const canAddMember = computed(() => project.value && auth.user && (auth.isAdmin || isOwner(auth.user.id) || isDeptLeaderOfProject.value));

const canSettings = computed(() => auth.user && (auth.isAdmin || isOwner(auth.user.id) || isDeptLeaderOfProject.value));

/** 排期计划可编辑：与后端 saveSchedule 同口径（系统管理员或项目负责人） */
const canManageSchedule = computed(() => !!auth.user && (auth.isAdmin || project.value?.ownerId === auth.user.id));

/** 当前用户是否为该项目某个主要关联部门的负责人 */
const isDeptLeaderOfProject = computed(
  () => !!auth.user && (project.value?.departments || []).some((d: any) => d.leaderId === auth.user!.id),
);

/** 可设置成员岗位（项目负责人、主要关联部门负责人或系统管理员） */
const canSetPosition = computed(() => !!auth.user && (auth.isAdmin || isOwner(auth.user.id) || isDeptLeaderOfProject.value));

/** 当前用户是否为项目创建人 */
const isMeAsOwner = computed(() => !!auth.user && project.value?.ownerId === auth.user!.id);
/** 当前用户是否为项目主审批人（或系统管理员兵底可处理 PENDING） */
const isPrimaryApprover = computed(
  () => !!auth.user && (project.value?.approverId === auth.user!.id || auth.isAdmin),
);
/** 当前用户是否为被加签的审批人（非主审批人） */
const isCoReviewer = computed(() => {
  if (!auth.user || isPrimaryApprover.value) return false;
  return (project.value?.coReviews || []).some((c: any) => c.reviewer?.id === auth.user!.id);
});
/** 我在加签名单中且尚未给出结论 → 展示同意/驳回按钮 */
const myPendingCosign = computed(() => {
  if (!auth.user) return null;
  return (project.value?.coReviews || []).find((c: any) => c.reviewer?.id === auth.user!.id && c.status === 'PENDING') || null;
});
/** 可加签候选：全员中去掉主审批人、发起人、已加签者与停用者 */
const cosignCandidates = computed(() => {
  const p = project.value;
  if (!p) return [];
  const used = new Set<string>([p.approverId, p.ownerId, ...(p.coReviews || []).map((c: any) => c.reviewer?.id)]);
  return users.value.filter((u: any) => u.active !== false && !used.has(u.id));
});

// ---- 审批交互 ----
const approving = ref(false);
const approveDialogVisible = ref(false);
const approveMode = ref<'approve' | 'reject'>('approve');
const approveNote = ref('');
function openApproveDialog(mode: 'approve' | 'reject') {
  approveMode.value = mode;
  approveNote.value = '';
  approveDialogVisible.value = true;
}
async function submitApprove() {
  if (approveMode.value === 'reject' && !approveNote.value.trim()) {
    ElMessage.warning('驳回必须填写意见');
    return;
  }
  approving.value = true;
  try {
    if (approveMode.value === 'approve') {
      const r: any = await projectsApi.approve(project.value!.id, approveNote.value.trim() || undefined);
      if (r?.pendingCoReviewers > 0) ElMessage.success(`已记录审批意见，还需 ${r.pendingCoReviewers} 位加签人同意后项目才生效`);
      else ElMessage.success('已批准，项目已启动');
    } else {
      await projectsApi.reject(project.value!.id, approveNote.value.trim());
      ElMessage.success('已驳回');
    }
    approveDialogVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '处理失败');
  } finally {
    approving.value = false;
  }
}

// ---- 加签联审 ----
const cosignDialogVisible = ref(false);
const cosignIds = ref<string[]>([]);
const cosigning = ref(false);
function openCosignDialog() {
  cosignIds.value = [];
  cosignDialogVisible.value = true;
}
async function submitCosign() {
  cosigning.value = true;
  try {
    await projectsApi.addCoReviewers(project.value!.id, cosignIds.value);
    ElMessage.success('已加签，对方将收到站内信');
    cosignDialogVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加签失败');
  } finally {
    cosigning.value = false;
  }
}
async function removeCosigner(coReviewId: string) {
  try {
    await projectsApi.removeCoReviewer(project.value!.id, coReviewId);
    ElMessage.success('已移除加签人');
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '移除失败');
  }
}
const cosignDecideVisible = ref(false);
const cosignDecideMode = ref<'APPROVED' | 'REJECTED'>('APPROVED');
const cosignDecideNote = ref('');
function openCosignDecide(mode: 'APPROVED' | 'REJECTED') {
  cosignDecideMode.value = mode;
  cosignDecideNote.value = '';
  cosignDecideVisible.value = true;
}
async function submitCosignDecide() {
  if (cosignDecideMode.value === 'REJECTED' && !cosignDecideNote.value.trim()) {
    ElMessage.warning('驳回必须填写意见');
    return;
  }
  approving.value = true;
  try {
    const r: any = await projectsApi.decideCoReview(project.value!.id, {
      decision: cosignDecideMode.value,
      note: cosignDecideNote.value.trim() || undefined,
    });
    if (r?.rejected) ElMessage.success('已驳回，项目退回发起人修改');
    else if (r?.remaining > 0) ElMessage.success(`已同意，还需 ${r.remaining} 位加签人审批`);
    else ElMessage.success('已同意；若主审批人已批准，项目将自动启动（请刷新查看）');
    cosignDecideVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '处理失败');
  } finally {
    approving.value = false;
  }
}

// ---- 重提交（目前仅支持基本信息与需求文档重选，时间计划/里程碑保持现有） ----
const resubmitDialogVisible = ref(false);
function openResubmitDialog() {
  resubmitDialogVisible.value = true;
}
async function submitResubmit() {
  try {
    await projectsApi.resubmit(project.value!.id, {
      name: resubmitForm.name,
      description: resubmitForm.description,
    });
    ElMessage.success('已重新提交审批');
    resubmitDialogVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '重提交失败');
  }
}
const resubmitForm = reactive({ name: '', description: '' });
watch(
  () => project.value,
  (p: any) => {
    if (p) {
      resubmitForm.name = p.name || '';
      resubmitForm.description = p.description || '';
    }
  },
  { immediate: true },
);

// ---- 项目健康度分析 ----
const analyzing = ref(false);
async function analyzeHealth() {
  if (!project.value) return;
  analyzing.value = true;
  try {
    const r: any = await projectsApi.analyzeHealth(project.value.id);
    if (r?.ok === false) {
      ElMessage.warning(r?.message || 'AI 不可用，本次未更新');
    } else {
      ElMessage.success('分析完成');
    }
    await load();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '分析失败');
  } finally {
    analyzing.value = false;
  }
}
/** 拆行风险/建议 */
function splitLines(s?: string | null): string[] {
  return (s || '').split('\n').map((x) => x.trim()).filter(Boolean);
}
const healthRisks = computed(() => splitLines(project.value?.healthRisks));
const healthSuggestions = computed(() => splitLines(project.value?.healthSuggestions));
const healthLevelClass = computed(() => {
  const lv = project.value?.healthLevel;
  return lv === 'GREEN' ? 'health-green' : lv === 'YELLOW' ? 'health-yellow' : lv === 'RED' ? 'health-red' : '';
});
const healthLevelLabel = computed(() => {
  const lv = project.value?.healthLevel;
  return lv === 'GREEN' ? '健康' : lv === 'YELLOW' ? '关注' : lv === 'RED' ? '高风险' : '未分析';
});

/** 项目时间计划：距到期天数（无 endDate 则 null） */
const remainingDays = computed<number | null>(() => {
  const end = project.value?.endDate;
  if (!end) return null;
  const d = new Date(end).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.floor((d - Date.now()) / 86400000);
});

/** 里程碑完成判定：项目内任一已完成任务 dueDate >= 里程碑 dueDate 就算完成（启发式，无则默认 false） */
function isMilestoneDone(ms: any): boolean {
  if (!ms?.dueDate) return false;
  const end = new Date(ms.dueDate).getTime();
  const tasks: any[] = (project.value?.boards || [])
    .flatMap((b: any) => (b.columns || []).flatMap((c: any) => c.tasks || []));
  return tasks.some((t) => t.status === 'DONE' && t.dueDate && new Date(t.dueDate).getTime() <= end);
}

/** 可转让的候选人（项目成员中除当前负责人） */
const transferCandidates = computed(() =>
  (project.value?.members || []).filter((m: any) => m.userId !== project.value?.ownerId),
);

const availableUsers = computed(() => {
  const memberIds = new Set((project.value?.members || []).map((m: any) => m.userId));
  memberIds.add(project.value?.ownerId);
  return users.value.filter((u) => !memberIds.has(u.id));
});

function isOwner(userId: string) {
  return project.value?.ownerId === userId;
}

function isOverdue(d: string) {
  return dayjs(d).isBefore(dayjs(), 'day');
}

/** 打开任务详情抽屉 */
function openTaskDetail(row: any) {
  currentTaskId.value = row.id;
  taskDrawer.value = true;
}

/** 从进展打开已关联的任务（拖拽余波点击时忽略） */
function openLinkedTask(taskId: string) {
  if (merge.consumeClick()) return;
  openTaskDetail({ id: taskId });
}

/** 拉取项目下全部任务（含负责人/进度/最近更新时间），失败不阻断详情展示 */
async function loadTasks() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  tasksLoading.value = true;
  try {
    tasks.value = await tasksApi.list({ projectId: id });
  } catch {
    /* 项目详情主流程已提示，任务清单静默 */
  } finally {
    tasksLoading.value = false;
  }
}

function canManageMember(userId: string) {
  return isOwner(userId) ? false : auth.isAdmin || isOwner(auth.user?.id) || isDeptLeaderOfProject.value;
}

/** 详情数据写操作后同步编辑表单 */
function syncEditForm() {
  editForm.name = project.value.name ?? '';
  editForm.description = project.value.description ?? '';
  editForm.color = project.value.color ?? '#428bff';
  editForm.dingtalkConversationId = project.value.dingtalkConversationId ?? '';
  editForm.dingtalkGroupName = project.value.dingtalkGroupName ?? '';
  editForm.dailyDigestEnabled = project.value.dailyDigestEnabled ?? false;
  editForm.digestTime = project.value.digestTime ?? '20:00';
  editForm.digestEveryDays = project.value.digestEveryDays ?? 1;
  editForm.archived = project.value.archived ?? false;
  editForm.hasHardware = project.value.hasHardware ?? false;
  editForm.hasGithub = project.value.hasGithub ?? true;
  editForm.departmentIds = (project.value.departments || []).map((d: any) => d.id);
  editForm.confidential = project.value.confidential ?? false;
}

// ---- 项目文档（复用知识库：visibility=PROJECT，项目成员与主要关联部门负责人可见） ----
const DOC_VIS_LABEL: Record<string, string> = { PUBLIC: '团队', DEPARTMENT: '部门', PROJECT: '项目', PRIVATE: '个人' };
const projDocs = ref<any[]>([]);
const docFormVisible = ref(false);
/** 项目文档空间（二进制文件）抽屉 */
const docSpaceVisible = ref(false);
const docSaving = ref(false);
const docForm = reactive({ title: '', content: '', docType: '' });
/** 类型下拉：预置词表 + 本项目已用过的自定义类型 */
const docTypeChoices = computed(() => docTypeOptions(projDocs.value.map((d: any) => d.docType)));
const docDetailVisible = ref(false);
const currentDoc = ref<any>(null);

// ---- 附件：上传项目文档时可附带任意格式附件（files/upload?docId），详情里点击预签名链接下载 ----
const docFiles = ref<File[]>([]);
const docFileInput = ref<HTMLInputElement | null>(null);
function onDocFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) docFiles.value.push(...Array.from(input.files));
  input.value = '';
}
function fmtSize(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
async function downloadAttachment(a: any) {
  try {
    const r: any = await filesApi.presign(a.fileKey);
    if (r?.url) window.open(r.url, '_blank');
    else ElMessage.error('未取得下载链接');
  } catch {
    ElMessage.error('获取下载链接失败');
  }
}

// ---- 项目文档 ----

async function loadProjDocs() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  projDocs.value = await knowledgeApi.list({ projectId: id }).catch(() => []);
}

// ---- 项目文件页（扁平化）：在线文档 + 文件平铺一行一条，类型小标签可选可手输 ----
const WEEK_DOC_TYPE = '周报文档'; // 「上传周报文档」入口统一打此类型，周报页按周查看
const DOC_TYPE_3D = '3D 模型'; // 3D 打印格式自动打标（未手选类型时）
const _3D_EXTS = ['stl', 'obj', 'step', 'stp', '3mf', 'glb', 'gltf', 'ply'];
const docCenterItems = ref<any[]>([]);
const docSearch = ref('');
const docPreviewVisible = ref(false);
const docPreviewItem = ref<any>(null);
const weekUploading = ref(false);
const weekFileInput = ref<HTMLInputElement | null>(null);
const fileUploadInput = ref<HTMLInputElement | null>(null);
const replaceFileInput = ref<HTMLInputElement | null>(null);
const replaceTarget = ref<any>(null);
const uploadDocType = ref('');
const typeEditVisible = ref(false);
const typeEditTarget = ref<any>(null);
const typeEditValue = ref('');
const typeSaving = ref(false);

/** ISO 周标记（与后端同算法）：2026-W47（周报 tab「本周文档」标题与空态判断用） */
function isoWeekOf(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
const currentWeekKey = computed(() => isoWeekOf(new Date()));

const docCenterFiltered = computed(() => {
  let items = docCenterItems.value;
  const kw = docSearch.value.trim().toLowerCase();
  if (kw) items = items.filter((i: any) => (i.name || '').toLowerCase().includes(kw));
  return items;
});

/** 类型下拉：预置 + 3D 模型 + 本项目已用过的自定义类型 */
const uploadTypeOptions = computed(() =>
  docTypeOptions([...docCenterItems.value.map((i: any) => i.docType), DOC_TYPE_3D]),
);

function is3DFile(name: string): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return _3D_EXTS.includes(ext);
}

/** 周报文档按周归组（周报 tab 继续使用） */
const weekKeys = computed(() =>
  Array.from(new Set(docCenterItems.value.map((i: any) => i.weekKey).filter(Boolean) as string[])).sort().reverse(),
);
const weekDocKey = ref('');
watch(weekKeys, (ks) => {
  if (!weekDocKey.value || !ks.includes(weekDocKey.value)) weekDocKey.value = ks[0] ?? '';
}, { immediate: true });
const weekDocs = computed(() =>
  docCenterItems.value.filter((i: any) => i.weekKey === weekDocKey.value && i.docType === WEEK_DOC_TYPE),
);

async function loadDocCenter() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  docCenterItems.value = await documentsApi
    .projectAll(id)
    .then((r: any) => r?.items ?? [])
    .catch(() => []);
}

/** 类型徽标文案：按扩展名归类展示 */
function badgeOf(it: any): string {
  const ext = (it.name || '').includes('.') ? (it.name || '').split('.').pop()!.toLowerCase() : '';
  if (it.kind === 'doc' || ['md', 'txt', 'log', 'json', 'yml', 'yaml', 'xml'].includes(ext)) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['stl', 'obj', 'step', 'stp', '3mf', 'glb', 'gltf', 'ply'].includes(ext)) return 'threed';
  return 'file';
}
function badgeText(it: any): string {
  const map: Record<string, string> = { text: '文档', pdf: 'PDF', doc: 'DOC', sheet: '表格', image: '图片', threed: '3D', file: '文件' };
  return map[badgeOf(it)] ?? '文件';
}

function docCenterMeta(it: any): string {
  const size = it.size ? fmtSize(it.size) : '';
  const time = it.createdAt ? String(it.createdAt).slice(5, 10) : '';
  return [size, it.uploaderName, `${time} 上传`].filter(Boolean).join(' · ');
}

/** 能否在线预览：在线文档一律可预览；文件看后端给的 previewKind（3D 等不可预览 → 直接下载） */
function canPreview(it: any): boolean {
  if (it.kind === 'doc') return true;
  return !!it.previewKind && it.previewKind !== 'none';
}

function previewDoc(it: any) {
  // 不可预览的文件（3D 模型等）点文件名直接下载
  if (!canPreview(it)) {
    downloadDocFile(it);
    return;
  }
  docPreviewItem.value = {
    kind: it.kind,
    id: it.id,
    name: it.name,
    mimeType: it.mimeType,
    size: it.size,
    uploaderName: it.uploaderName,
    updatedAt: it.updatedAt,
    previewKind: it.kind === 'doc' ? 'text' : it.previewKind,
  };
  docPreviewVisible.value = true;
}

async function downloadDocFile(it: any) {
  try {
    const blob = await documentsApi.content(it.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = it.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    ElMessage.error('下载失败');
  }
}

/** 上传文件：weekOnly=true 走「上传周报文档」（统一打周报文档类型，自动归当前 ISO 周）；
 *  普通上传带工具栏选的类型标签（可空=未分类）；3D 打印格式未手选类型时自动打「3D 模型」 */
async function onFilesPicked(weekOnly: boolean) {
  const input = (weekOnly ? weekFileInput : fileUploadInput).value as HTMLInputElement | null;
  const files = Array.from(input?.files ?? []);
  if (input) input.value = '';
  if (!files.length || !project.value) return;
  weekUploading.value = true;
  let ok = 0;
  try {
    for (const f of files) {
      const docType = weekOnly
        ? WEEK_DOC_TYPE
        : uploadDocType.value.trim() || (is3DFile(f.name) ? DOC_TYPE_3D : '');
      try {
        await documentsApi.upload(f, { scope: 'project', targetId: project.value.id, docType: docType || undefined });
        ok += 1;
      } catch (e: any) {
        ElMessage.warning(`「${f.name}」上传失败：${e?.response?.data?.message || '未知错误'}`);
      }
    }
    if (ok) {
      ElMessage.success(weekOnly ? `已上传 ${ok} 个周报文档，归入本周（${currentWeekKey.value}）` : `已上传 ${ok} 个文件`);
      await loadDocCenter();
    }
  } finally {
    weekUploading.value = false;
  }
}

/** 替换文件：同名重新上传 → 服务端生成新版本（项目文件不可删除，替换是唯一更正方式） */
function startReplace(it: any) {
  replaceTarget.value = it;
  replaceFileInput.value?.click();
}

async function onReplacePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  const target = replaceTarget.value;
  if (!files.length || !target || !project.value) return;
  weekUploading.value = true;
  try {
    for (const f of files) {
      try {
        await documentsApi.upload(f, {
          scope: 'project',
          targetId: project.value.id,
          docType: target.docType || undefined,
          conflict: 'version',
        });
        ElMessage.success(`「${target.name}」已替换为新版本`);
      } catch (e: any) {
        ElMessage.warning(`替换失败：${e?.response?.data?.message || '未知错误'}`);
      }
    }
    await loadDocCenter();
  } finally {
    weekUploading.value = false;
    replaceTarget.value = null;
  }
}

/** 类型标签：点击小标签修改（预设可选 + 手动输入） */
function openTypeEdit(it: any) {
  typeEditTarget.value = it;
  typeEditValue.value = it.docType || '';
  typeEditVisible.value = true;
}

async function saveTypeEdit() {
  const target = typeEditTarget.value;
  if (!target) return;
  const val = (typeEditValue.value || '').trim();
  if (val.length > 12) {
    ElMessage.warning('自定义类型最长 12 字');
    return;
  }
  typeSaving.value = true;
  try {
    await documentsApi.patchFile(target.id, { docType: val || null });
    ElMessage.success(val ? `类型已设为「${val}」` : '已清除类型标签');
    typeEditVisible.value = false;
    await loadDocCenter();
  } catch (e: any) {
    ElMessage.warning(e?.response?.data?.message || '类型保存失败');
  } finally {
    typeSaving.value = false;
  }
}

/** 从周报页跳到文件页上传 */
function goDocCenter() {
  activeTab.value = 'docs';
}


async function openProjectDoc(d: any) {
  currentDoc.value = await knowledgeApi.get(d.id).catch(() => d);
  docDetailVisible.value = true;
}

async function saveProjectDoc() {
  if (!docForm.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }
  docSaving.value = true;
  try {
    const created: any = await knowledgeApi.create({
      title: docForm.title.trim(),
      content: docForm.content,
      docType: docForm.docType.trim() || null,
      projectId: project.value?.id,
      visibility: 'PROJECT',
    });
    // 附件逐个挂到新文档（失败不阻断保存，逐条提示）
    let okCount = 0;
    for (const f of docFiles.value) {
      try {
        await filesApi.upload(f, { docId: created?.id });
        okCount += 1;
      } catch {
        ElMessage.warning(`附件「${f.name}」上传失败`);
      }
    }
    ElMessage.success(okCount ? `项目文档已上传（附件 ${okCount} 个）` : '项目文档已上传');
    docFormVisible.value = false;
    Object.assign(docForm, { title: '', content: '', docType: '' });
    docFiles.value = [];
    await loadProjDocs();
  } finally {
    docSaving.value = false;
  }
}

async function load() {
  const id = String(route.params.id ?? '');
  if (!id) return;
  loading.value = true;
  try {
    project.value = await projectsApi.get(id);
    // 未签保密协议：后端只回锁定壳，任务/文档接口也会 403，不必再去拉
    if (ndaLocked.value) return;
    loadTasks(); // 任务清单，失败不阻断详情
    loadMeetings(); // 项目会议列表，失败不阻断详情
    loadWeekly(); // 项目周报就绪度与 AI 总结，失败不阻断详情
    loadProjDocs(); // 项目文档，失败不阻断详情
    loadDocCenter(); // 文档中心聚合，失败不阻断详情
    loadNotes(); // 项目纪要，失败不阻断详情
    loadChatUnread(); // 项目群未读红点，失败不阻断详情
    syncEditForm();
    transferUserId.value = '';
  } catch (e: any) {
    if (e?.response?.status === 404) {
      project.value = null;
    } else {
      ElMessage.error(e?.response?.data?.message || '加载项目失败');
    }
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  refreshing.value = true;
  if (!ndaLocked.value) {
    loadTasks();
    loadMeetings();
    loadWeekly();
  }
  try {
    project.value = await projectsApi.get(String(route.params.id));
  } finally {
    refreshing.value = false;
  }
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push('/projects');
}

/** 打开项目设置弹窗（先同步当前详情到表单，避免上次未保存残留） */
function openSettings() {
  if (!project.value) return;
  syncEditForm();
  transferUserId.value = '';
  settingsVisible.value = true;
}

async function saveSettings() {
  if (!editForm.name.trim()) {
    ElMessage.warning('项目名称不能为空');
    return;
  }
  saving.value = true;
  const wasConfidential = !!project.value.confidential;
  const wantConfidential = !!editForm.confidential;
  try {
    await projectsApi.update(project.value.id, {
      name: editForm.name.trim(),
      description: editForm.description,
      color: editForm.color,
      dingtalkConversationId: editForm.dingtalkConversationId || null,
      dingtalkGroupName: editForm.dingtalkGroupName || null,
      dailyDigestEnabled: editForm.dailyDigestEnabled,
      digestTime: editForm.digestTime || '20:00',
      digestEveryDays: editForm.digestEveryDays || 1,
      archived: editForm.archived,
      hasHardware: editForm.hasHardware,
      hasGithub: editForm.hasGithub,
      departmentIds: editForm.departmentIds,
    });
    // 保密标记走独立接口（仅管理员）：通用改项目接口会一律忽略 confidential
    if (auth.isAdmin && wantConfidential !== wasConfidential) {
      const r: any = await projectsApi.setConfidential(project.value.id, wantConfidential);
      ElMessage.success(
        wantConfidential
          ? `已设为保密项目，${r?.notified ?? 0} 位成员收到签署提醒`
          : '已取消保密标记，项目内容恢复常规可见性',
      );
    } else {
      ElMessage.success('项目设置已保存');
    }
    settingsVisible.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

/** 立即把本项目最近进展发到本项目绑定钉钉群 */
async function sendDigestNow() {
  sendingNow.value = true;
  try {
    const r: any = await projectsApi.digestNow(project.value.id);
    if (r?.skipped) ElMessage.warning(r.reason || '未发送');
    else if (r?.ok) ElMessage.success('已发送到项目群');
    else ElMessage.error(r?.error || '发送失败');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '发送失败');
  } finally {
    sendingNow.value = false;
  }
}

/** 删除项目（仅管理员）：二次确认后移入回收站（软删除）并返回项目列表 */
async function deleteProject() {
  if (!project.value) return;
  try {
    await ElMessageBox.confirm(
      `确定将项目「${project.value.name}」移入回收站？项目会从列表与首页隐藏，但数据保留，可在「项目 - 回收站」恢复或彻底删除。`,
      '删除项目',
      { type: 'warning', confirmButtonText: '移入回收站' },
    );
  } catch {
    return; // 用户取消
  }
  deleting.value = true;
  try {
    await projectsApi.remove(project.value.id);
    ElMessage.success('项目已移入回收站');
    router.replace('/projects');
  } finally {
    deleting.value = false;
  }
}

/** 填写群名 → 调后端校验唯一命中 → 关联成功 */
async function resolveGroup() {
  const name = (editForm.dingtalkGroupName || '').trim();
  if (!name) {
    ElMessage.warning('请先填写钉钉群名称');
    return;
  }
  resolvingEdit.value = true;
  try {
    const r: any = await projectsApi.resolveDingtalkGroup(name);
    editForm.dingtalkConversationId = r.conversationId;
    editForm.dingtalkGroupName = r.name;
    ElMessage.success(`已关联钉钉群：${r.name}`);
  } catch (e: any) {
    editForm.dingtalkConversationId = '';
    ElMessage.error(e?.response?.data?.message || '群校验失败，请稍后重试');
  } finally {
    resolvingEdit.value = false;
  }
}

/** 取消已关联的群 */
function unlinkGroup() {
  editForm.dingtalkConversationId = '';
  editForm.dingtalkGroupName = '';
}

/** 手动拉取最近 days 天群消息并触发 AI 总结，完成后轮询刷新进展（默认 2 天） */
let pollTimer: ReturnType<typeof setInterval> | undefined;
let disposed = false;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function summarizeFlow(days = 2) {
  summarizing.value = true;
  try {
    const r: any = await projectsApi.summarize(project.value.id, days);
    if (r.error) {
      ElMessage.error(r.error);
      return;
    }
    ElMessage.success(`已拉取最近 ${days} 天消息（新增 ${r.added ?? 0} 条），AI 进展总结后台生成中，完成后自动刷新…`);
    await waitForUpdate();
  } finally {
    summarizing.value = false;
  }
}

/** 每 4 秒轮询详情，最多 60 秒：进展数量变多或最新一条变化即判定总结完成 */
async function waitForUpdate() {
  const id = project.value?.id;
  const base = project.value?.updates?.[0]?.id ?? '';
  const baseCount = project.value?.updates?.length ?? 0;
  for (let i = 0; i < 15 && !disposed; i++) {
    await new Promise((res) => setTimeout(res, 4000));
    if (disposed) return;
    try {
      const fresh: any = await projectsApi.get(id);
      const count = fresh.updates?.length ?? 0;
      const firstId = fresh.updates?.[0]?.id ?? '';
      if (count > baseCount || (count > 0 && firstId !== base)) {
        project.value = fresh;
        updatePage.value = 1; // 新总结排在最前，回到第一页即可看到
        ElMessage.success('进展总结已生成');
        return;
      }
    } catch {
      /* 单次轮询失败不中断 */
    }
  }
  ElMessage.info('总结仍在生成中，可稍后点「刷新」查看');
}

async function addMember() {
  await projectsApi.addMember(project.value.id, newMemberId.value);
  newMemberId.value = '';
  ElMessage.success('已添加成员');
  await load();
}

async function removeMember(userId: string) {
  await ElMessageBox.confirm('确定移除该成员？', '移除成员', { type: 'warning' });
  await projectsApi.removeMember(project.value.id, userId);
  ElMessage.success('已移除');
  await load();
}

/** 设置成员岗位（负责人、所属部门负责人或系统管理员） */
async function setMemberPosition(userId: string, position: string | null) {
  await projectsApi.setMemberPosition(project.value.id, userId, position);
  ElMessage.success(position ? '已设置岗位' : '已清空岗位');
  await load();
}

/** 转让项目负责人（仅当前负责人或系统管理员） */
async function transferOwner() {
  const target = project.value.members.find((m: any) => m.userId === transferUserId.value);
  await ElMessageBox.confirm(
    `确定将负责人转让给「${target?.user?.name}」？转让后你将自动降为普通成员。`,
    '转让项目负责人',
    { type: 'warning' },
  );
  await projectsApi.transferOwner(project.value.id, transferUserId.value);
  ElMessage.success('项目负责人已转让');
  await load();
}

async function createBoard() {
  boardCreating.value = true;
  try {
    await projectsApi.createBoard(project.value.id, `看板 ${(project.value.boards?.length || 0) + 1}`);
    ElMessage.success('看板已创建');
    await load();
  } finally {
    boardCreating.value = false;
  }
}

// ---- 从进展创建/关联任务（弹窗组件在首页与详情页共用） ----
const convertVisible = ref(false);
const convertUpdate = ref<any>(null);
const convertSourceText = ref('');

/** 打开转换弹窗：sourceText 为点击的要点文本（初始化在组件内完成） */
function openConvertDialog(u: any, sourceText?: string) {
  // 拖拽/长按拖拽松手后的余波点击：不打开转换弹窗
  if (merge.consumeClick()) return;
  convertUpdate.value = u;
  convertSourceText.value = (sourceText ?? String(u?.content ?? '')).trim();
  convertVisible.value = true;
}

onMounted(async () => {
  users.value = await usersApi.list();
  positions.value = await departmentsApi.positions().catch(() => []);
  departments.value = await departmentsApi.list().catch(() => []);
  load();
});

watch(
  () => route.params.id,
  () => {
    stopPolling();
    updatePage.value = 1; // 切换项目回到第一页
    load();
  },
);

onUnmounted(() => {
  disposed = true;
  stopPolling();
});

// ---- 概览底部「项目信息」折叠区：负责人 / 成员 / 介绍，默认收起 ----
const infoOpen = ref(false);
</script>

<style scoped>
/* 项目详情页头：深宝蓝渐变，与全站深色结构块一致 */
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 10px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, #0f3572 0%, #123e86 45%, #1b4fa8 75%, #428bff 100%);
  color: #fff;
  box-shadow: 0 6px 18px rgba(18, 62, 134, 0.28);
}
.detail-head :deep(.el-button.is-text:not(.is-disabled)) {
  color: #cfe3ff;
}
.detail-head :deep(.el-button.is-text:not(.is-disabled):hover) {
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
}
.detail-head .title {
  color: #fff;
}
.detail-head .muted {
  color: #c3d9f7;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-xl);
  font-weight: 700;
  margin-top: 2px;
}
.head-title .title {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 窄屏：标题 + 保密/存档/钉钉群/部门标签一行放不下，不换行会把整页顶出横向滚动条 */
@media (max-width: 767px) {
  .head-title {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .head-title .title {
    max-width: 100%;
  }
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
/* ---- 概览底部「项目信息」折叠区：负责人 / 成员 / 项目介绍，默认收起 ---- */
.info-card {
  padding: 10px 16px;
}
.info-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  min-height: 28px;
}
.info-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.info-hint {
  font-size: 12px;
  flex-shrink: 0;
}
.info-arrow {
  color: #909399;
  transition: transform 0.2s;
  flex-shrink: 0;
}
.info-arrow.open {
  transform: rotate(180deg);
}
.info-body {
  display: grid;
  grid-template-columns: 200px minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f2f5;
}
.info-block .member {
  padding: 4px 0;
}
.info-desc {
  font-size: 13px;
  line-height: 1.6;
  color: #606266;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
@media (max-width: 900px) {
  .info-body {
    grid-template-columns: 1fr;
  }
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 14px;
  align-items: start;
}
/* ---- Tab 分组：一次只看一组重点板块，代替原来一拉到头的瀑布流 ---- */
.pd-tabs :deep(> .el-tabs__content) {
  padding: 0;
}
/* v-show 保留各 pane DOM：切来切去不重复请求，日报/会议等面板的已加载状态直接复用 */
.pd-tabs :deep(> .el-tabs__content > .el-tab-pane) {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 窄屏：tab 栏自身可横向滚动，项不收缩，否则 6 个 Tab 会被挤到截字 */
@media (max-width: 767px) {
  .pd-tabs :deep(> .el-tabs__header .el-tabs__item) {
    flex-shrink: 0;
    white-space: nowrap;
  }
}
.side {
  display: grid;
  gap: 14px;
}
@media (max-width: 900px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
/* 手机窄屏：页头各信息块允许换行堆叠，避免描述/元信息撑出屏幕导致横向滚动 */
@media (max-width: 767px) {
  .head-left {
    flex-wrap: wrap;
  }
  .desc {
    flex-basis: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
.block-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.block-title {
  font-weight: 600;
  font-size: 15px;
}
.update-item {
  padding: 6px 0;
  border-top: 1px solid #f0f2f5;
}
.update-item:first-of-type {
  border-top: none;
}
/* 当天生成的进展高亮（fresh）：左侧主色条浅蓝底，时间主色加粗 */
.update-item.fresh {
  border-left: 3px solid var(--el-color-primary);
  background: #f0f7ff;
  padding: 5px 8px;
  border-radius: 4px;
}
.update-item.fresh .update-time {
  color: var(--el-color-primary);
  font-weight: 600;
}
/* 已转为任务的进展：蓝色左侧色条 + 浅蓝底；头部带可点开的「已转为任务」标签 */
.update-item.converted {
  border-left: 3px solid var(--el-color-primary);
  background: #f5faff;
  padding: 5px 8px;
  border-radius: 4px;
}
.update-item.converted .update-converted {
  cursor: pointer;
}
/* 拖拽合并：源条目半透明，命中目标高亮 */
.update-item.dragging {
  opacity: 0.5;
}
.update-item.drag-over {
  outline: 1px dashed var(--el-color-primary);
  outline-offset: -1px;
  background: rgba(66, 139, 255, 0.12);
}
.merge-tip {
  font-size: 12px;
  font-weight: 400;
  margin-left: 8px;
}
.update-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 1px;
}
.update-time {
  font-size: 12px;
  color: #909399;
}
/* 「转为任务」收敛到头部行右侧，省掉原先底部一整行 */
.update-head .update-convert {
  margin-left: auto;
  height: 20px;
  padding: 0 4px;
}
.update-content {
  font-size: 13px;
  color: #303133;
  line-height: 1.5;
}
/* markdown 渲染出的段落/列表默认上下 margin 偏大，这里压平以提升列表密度 */
.update-content :deep(p) {
  margin: 0;
}
.update-content :deep(p + p) {
  margin-top: 3px;
}
.update-content :deep(h1),
.update-content :deep(h2),
.update-content :deep(h3),
.update-content :deep(h4) {
  margin: 0 0 2px;
  font-size: var(--fs-md);
  font-weight: 600;
}
.update-content :deep(ul),
.update-content :deep(ol) {
  margin: 2px 0;
  padding-left: 18px;
}
.update-content :deep(li) {
  margin: 0;
}
.update-content :deep(blockquote),
.update-content :deep(pre) {
  margin: 3px 0;
}
.update-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.empty {
  font-size: 13px;
  color: #909399;
  padding: 8px 0;
}
.tasks-card {
  margin-top: 0;
}
.task-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.task-cell-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.tag-row {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.progress-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.progress-cell .el-progress {
  flex: 1;
}
.due {
  color: #606266;
  background: #f0f2f5;
  border-radius: 4px;
  padding: 1px 6px;
}
.due.overdue {
  color: #f56c6c;
  background: #fef0f0;
}
.page-empty {
  text-align: center;
  padding: 60px 0;
}
.member {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
.member-name {
  flex: 1;
  font-size: 14px;
}
/* 成员姓名改可点（进画像）：保持原来的黑字，只在悬停时变主色，不让侧栏满屏链接蓝 */
.member-name.name-link {
  color: inherit;
  cursor: pointer;
}
.member-name.name-link:hover {
  color: var(--el-color-primary);
}
.owner-tag {
  color: #e6a23c;
}
.member-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.doc-space-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.board-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px dashed #f0f2f5;
  font-size: 14px;
}
.group-resolve {
  width: 100%;
}
.group-hint {
  font-size: 12px;
  margin-top: 4px;
}
.settings-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.danger-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #e4e7ed;
}
.danger-zone .muted {
  font-size: 12px;
}
.transfer-owner {
  display: flex;
  gap: 8px;
  width: 100%;
}
.digest-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.digest-switch .muted {
  font-size: 12px;
  line-height: 1.5;
}
/* 保密协议遮罩（未签署时整页只出这一块，不渲染项目内容）；保留 .page-card 默认 padding，深色标题条靠负边距齐边 */
.nda-head {
  padding: 0;
  font-size: 14px;
  line-height: 1.6;
}
.nda-body {
  margin: 12px 0;
  padding: 12px 14px;
  max-height: 56vh;
  overflow: auto;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fbfcfe;
}
.nda-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.nda-foot .muted {
  font-size: 12px;
}
.nda-actions {
  display: flex;
  gap: 8px;
}
/* 项目规则卡（F5）：正文 Markdown + 已阅比例 + 名单 + 「我已阅」 */
.rules-meta {
  font-size: 12px;
}
.rules-ops {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.rules-empty {
  padding: 6px 0 2px;
  font-size: 13px;
}
.rule-item {
  padding: 12px 0 2px;
  border-top: 1px solid var(--app-border);
}
.rule-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rule-title {
  font-size: 14px;
  font-weight: 600;
}
.rule-by {
  font-size: 12px;
  margin-top: 2px;
}
.rule-body {
  margin: 8px 0;
}
.rule-acks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.ack-chip {
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 10px;
  background: #f1f5f9;
  color: #475569;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ack-chip i {
  font-style: normal;
  color: #94a3b8;
}
.rule-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ack-note {
  width: 240px;
  max-width: 100%;
}
.acked-hint {
  color: #16a34a;
  font-size: 12px;
}
.rule-ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.rules-roster {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fbfcfe;
}
.roster-col {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.roster-h {
  margin-right: 4px;
  font-size: 12px;
  font-weight: 600;
}
.roster-chip {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}
.roster-chip.read {
  background: #ecfdf5;
  color: #15803d;
}
.roster-chip.unread {
  background: #fff7ed;
  color: #c2410c;
}
.rule-preview {
  margin-top: 4px;
  padding: 8px 12px;
  border: 1px dashed var(--app-border);
  border-radius: 8px;
}
.rule-edit-tip {
  font-size: 12px;
  line-height: 1.5;
}
/* 项目纪要卡（进度/汇报/备注）：类型 chips + 可收起条目列表 */
/* 规则/纪要区块高亮：左侧强调边条 + 浅色底，与普通说明卡区分 */
.rules-card,
.notes-card {
  border-left: 3px solid var(--el-color-primary);
  background: linear-gradient(180deg, var(--el-color-primary-light-9) 0%, transparent 72px);
}
/* 纪要督促条：常规浅蓝提示；≥7 天未更新转橙色警示 */
.note-nudge {
  margin: 2px 0 10px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--el-color-primary-light-9);
  color: var(--el-text-color-regular);
}
.note-nudge.stale {
  background: #fff7ed;
  color: #c2410c;
  font-weight: 600;
}
/* 任务清单负责人标签筛选条 */
.assignee-filter {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 2px 0 10px;
}
.af-chip {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 0.5px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.af-chip:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary-light-5);
}
.af-chip.on {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
  font-weight: 600;
}
.note-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 4px 0 12px;
}
.note-chip {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 0.5px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  user-select: none;
}
.note-chip.on {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
}
.note-item {
  border: 0.5px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.note-item.open {
  background: var(--el-fill-color-light);
}
.note-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.note-title {
  font-size: 13.5px;
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-caret {
  font-size: 12px;
  flex-shrink: 0;
}
.note-by {
  font-size: 11.5px;
  margin-top: 4px;
}
.note-ops {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 4px;
}
.note-more {
  text-align: center;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  padding: 6px 0 2px;
  user-select: none;
}
/* 项目群悬浮按钮：详情页右上角，带未读红点 */
.pchat-fab {
  position: fixed;
  top: 96px;
  right: 22px;
  z-index: 1200;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--el-color-primary);
  color: #fff;
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.pchat-fab-ico {
  font-weight: 500;
}
.pchat-badge {
  background: #f56c6c;
  color: #fff;
  font-size: 11px;
  border-radius: 999px;
  min-width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  padding: 0 5px;
}
/* ---- 成员周报卡片墙 ---- */
.wreport-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.wreport-card {
  background: #fff;
  border: 1px solid var(--app-border);
  border-left: 3px solid #67c23a;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: box-shadow 0.15s;
}
.wreport-card:hover {
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);
}
.wreport-card.is-miss {
  border-left-color: var(--el-border-color-darker);
  background: var(--el-fill-color-lighter);
  cursor: default;
}
.wreport-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wreport-name {
  font-weight: 600;
  font-size: 13px;
}
.wreport-tag {
  font-size: 11px;
  border-radius: 8px;
  padding: 0 8px;
  line-height: 18px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}
.wreport-tag.r-DEPT_LEADER {
  background: #ecf5ff;
  color: #428bff;
}
.wreport-tag.r-PROJ_OWNER {
  background: #fdf6ec;
  color: #e6a23c;
}
.wreport-miss {
  margin-left: auto;
  font-size: 11px;
  color: #f56c6c;
}
.wreport-body {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.wreport-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.wreport-full {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.8;
  max-height: 60vh;
  overflow: auto;
}
/* ---- 会议周日历 ---- */
.cal-week {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.cal-col {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-fill-color-lighter, #fafafa);
}
.cal-col.is-today {
  border-color: #428bff;
}
.cal-col-hd {
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  padding: 4px 0;
  background: var(--el-fill-color-light, #f5f5f5);
}
.cal-col-hd.today {
  color: #428bff;
  font-weight: 600;
  background: #eef4ff;
}
.cal-col-body {
  position: relative;
  height: 230px;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 18px,
    var(--el-border-color-lighter, #eee) 18px,
    var(--el-border-color-lighter, #eee) 19px
  );
}
.cal-block {
  position: absolute;
  left: 3px;
  right: 3px;
  background: #e6f1fb;
  border: 1px solid #7aa7dd;
  border-radius: 5px;
  padding: 2px 5px;
  font-size: 11px;
  line-height: 1.3;
  color: #0c447c;
  cursor: pointer;
  overflow: hidden;
}
.cal-block:hover {
  border-color: #428bff;
}
.cal-block.is-done {
  background: var(--el-fill-color, #f2f2f2);
  border-color: var(--el-border-color, #ddd);
  color: var(--el-text-color-secondary);
}
.cal-block-t {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cal-block-time {
  font-size: 11px;
  opacity: 0.8;
}
.cal-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
.cal-tip {
  font-size: 12px;
  margin-top: 8px;
}
/* 概览页「即将召开的会议」横幅 */
.next-meeting-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 10px;
  cursor: pointer;
  border-left: 3px solid var(--el-color-primary);
}
.nm-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-primary);
  flex-shrink: 0;
}
.nm-label {
  font-size: 12px;
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.nm-title {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 日报 tab 顶部快速写作入口卡 */
.report-entry-card {
  padding: 10px 16px;
  margin-bottom: 10px;
}
.report-tip {
  font-size: 12px;
  line-height: 1.5;
}
/* 定时发送：时间 + 频率行 */
.digest-sched {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.sched-lab {
  font-size: 13px;
  color: #606266;
}
/* 页头右侧「项目设置」按钮 */
.head-actions {
  margin-left: auto;
  flex-shrink: 0;
}
/* 项目文档 */
.doc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
  font-size: 14px;
}
.doc-row:last-of-type {
  border-bottom: none;
}
.doc-row:hover {
  background: #f8fafc;
}
.doc-name {
  flex: 1;
  min-width: 0;
}
.doc-empty {
  font-size: 13px;
  padding: 6px 0;
}
/* 文档中心：分类 chips + 统一列表行 */
.doc-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 4px 0 6px;
}
.doc-chip {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 12px;
  border: 1px solid #e4e7ed;
  color: #6b7280;
  cursor: pointer;
  user-select: none;
}
.doc-chip.active {
  background: #185fa5;
  border-color: #185fa5;
  color: #fff;
}
.doccenter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-bottom: 1px solid #f5f7fa;
}
.doccenter-row:last-of-type {
  border-bottom: none;
}
.doccenter-row:hover {
  background: #f8fafc;
}
.doccenter-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.doccenter-meta {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 1px;
}
.doc-badge {
  flex: 0 0 auto;
  width: 44px;
  height: 26px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}
.doc-badge.b-pdf {
  background: #fcebeb;
  color: #a32d2d;
}
.doc-badge.b-doc {
  background: #e6f1fb;
  color: #185fa5;
}
.doc-badge.b-sheet {
  background: #eaf3de;
  color: #3b6d11;
}
.doc-badge.b-text {
  background: #f1efe8;
  color: #5f5e5a;
}
.doc-badge.b-image {
  background: #fbeaf0;
  color: #993556;
}
.doc-badge.b-file {
  background: #f4f5f7;
  color: #6b7280;
}
.doc-badge.b-threed {
  background: #e6f1fb;
  color: #185fa5;
}
.doc-type-tag {
  flex: 0 0 auto;
  cursor: pointer;
}
.doc-week-tag {
  flex: 0 0 auto;
}
/* 文档附件：详情抽屉里的附件清单 */
.doc-att {
  margin-top: 14px;
}
.doc-att-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
}
.doc-att-row .muted {
  font-size: 12px;
}
.doc-attach-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 2px 0;
}
.doc-detail-meta {
  margin-bottom: 12px;
}
/* 类型下拉下方的可选类型提示（长文案换行不撑破弹窗） */
.doc-type-hint {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 4px;
}

/* ---- 项目审批横幅 ---- */
.approval-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-radius: 8px;
  margin-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.approval-banner.pending {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  color: #b88230;
}
.approval-banner.rejected {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  color: #c45656;
}
.banner-text {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 1;
  min-width: 220px;
}
.banner-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* 加签联审横幅：浅蓝底，名单可换行流动 */
.approval-banner.cosign {
  background: #f0f6ff;
  border: 1px solid #d9e8ff;
  color: #3b74c9;
}
.cosign-list {
  flex-wrap: wrap;
}
.cosign-item {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

/* ---- 项目分析卡 ---- */
.health-card .health-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}
.health-card .health-progress .el-progress {
  flex: 1;
}
.health-badge.health-green { background: #67c23a; color: #fff; }
.health-badge.health-yellow { background: #e6a23c; color: #fff; }
.health-badge.health-red { background: #f56c6c; color: #fff; }
.health-badge { border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.health-summary {
  font-size: 13px;
  color: #303133;
  margin: 6px 0;
  line-height: 1.6;
}
.health-block {
  margin-top: 8px;
}
.health-block-title {
  font-size: 12px;
  color: #909399;
  margin-bottom: 2px;
}
.health-list {
  margin: 0 0 0 20px;
  padding: 0;
  font-size: 13px;
  color: #606266;
}
.health-meta {
  font-size: 12px;
  margin-top: 8px;
}

/* ---- 时间计划区 ---- */
.plan-dates {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.plan-arrow {
  color: #c0c4cc;
}
.milestone-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.milestone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.milestone-row .ms-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.milestone-row .ms-date {
  font-size: 12px;
}

/* 项目会议卡：即将召开 / 历史会议分组，一行一场（日期 + 主题 + 状态） */
.meetings-card .mt-group + .mt-group {
  margin-top: 10px;
}
.mt-group-h {
  font-size: 12px;
  margin-bottom: 4px;
}
.mt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.mt-row:hover {
  background: #f5f7fa;
}
.mt-date {
  flex: none;
  width: 108px;
  color: #606266;
  font-variant-numeric: tabular-nums;
}
.mt-title {
  flex: 1;
  min-width: 0;
}
.mt-meta {
  flex: none;
  font-size: 12px;
}
.mt-tip {
  margin-top: 6px;
  font-size: 12px;
}
/* 项目周报卡片（F27） */
.weekly-ops {
  display: flex;
  align-items: center;
  gap: 10px;
}
.weekly-ready { font-size: 13px; }
.weekly-week { margin-top: 6px; font-size: 12px; }
.weekly-overview {
  margin-top: 10px;
  padding: 8px 10px;
  background: #f5f7fb;
  border-radius: 6px;
  line-height: 1.7;
  font-size: 13px;
  color: #303133;
}
.weekly-prog {
  margin: 8px 0 0;
  padding-left: 20px;
  line-height: 1.8;
  font-size: 13px;
  color: #303133;
}
.weekly-err { color: #e6a23c; margin-top: 8px; font-size: 12px; }
.weekly-tip { margin-top: 8px; font-size: 12px; }
.ready-full { color: #67c23a; }
.ready-part { color: #e6a23c; }
.ready-none { color: #f56c6c; }
</style>
