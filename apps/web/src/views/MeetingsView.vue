<template>
  <div class="page">
    <div class="page-title">
      会议活动
      <span v-if="myStats" class="my-score">
        我的活跃度 <b>{{ myStats.score }}</b> 分 · 出勤 {{ myStats.attended }} 次（活动 {{ myStats.activityCount }} · 会议 {{ myStats.meetingCount }}）
      </span>
      <el-button v-if="tab === 'list'" type="primary" @click="openCreate()">
        <el-icon><Plus /></el-icon>&nbsp;发起
      </el-button>
    </div>

    <!-- 大 tab：会议与活动列表 / 会议考勤（管理员，原独立页 /admin/meeting-stats 内迁到这里） -->
    <el-tabs v-model="tab" class="mt-tabs" @tab-change="onTabChange">
      <el-tab-pane label="会议与活动" name="list">

    <!-- 筛选：视角 + 类型 + 层级 + 搜索 -->
    <div class="page-card filter-card">
      <el-radio-group v-model="view" @change="load">
        <el-radio-button value="mine">我参加的</el-radio-button>
        <el-radio-button value="owned">我发起的</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <div class="scope-bar">
        <el-check-tag :checked="!scope" @change="scope = ''; load()">全部层级</el-check-tag>
        <el-check-tag
          v-for="s in SCOPES"
          :key="s.value"
          :checked="scope === s.value"
          @change="scope = scope === s.value ? '' : s.value; load()"
        >
          {{ s.label }}
        </el-check-tag>
      </div>
      <el-input v-model="keyword" placeholder="搜索会议/活动主题、议题…" clearable class="kw" @input="debounceLoad" />
      <div class="muted visibility-tip">
        「全部」对全员开放：本部门 / 本项目组 / 活动的会议能看完整内容，其余只显示标题、时间、地点与发起人
      </div>
    </div>

    <!-- 会议 / 活动列表 -->
    <div v-loading="loading" class="mt-list">
      <div v-if="!loading && !rows.length" class="muted empty">
        暂无会议或活动
        <div class="empty-tip">
          「发起」后自动按层级带出参会人与会前材料要求；选「发起活动」即一场活动（同样是层级中的一种）。每场都有重要性、签到二维码与文档
        </div>
      </div>
      <div v-for="r in rows" :key="r.id" class="page-card mt-card" @click="openDetail(r.id)">
        <div class="mt-head">
          <el-tag :type="STATUS[r.status]?.type" size="small" effect="dark">{{ STATUS[r.status]?.label }}</el-tag>
          <el-tag :type="IMPORTANCE[r.importance]?.type || 'info'" size="small" effect="plain">{{ IMPORTANCE[r.importance]?.label || '中' }}</el-tag>
          <b class="mt-title ellipsis">{{ r.title }}</b>
          <span v-if="r.scope !== 'ACTIVITY'" class="muted scope-chip">{{ TYPE_LABEL[r.type] || r.type }}</span>
          <span class="muted scope-chip">{{ SCOPE_LABEL[r.scope] }}</span>
          <span v-if="r.minutesReady" class="muted scope-chip">已有纪要</span>
          <el-tooltip v-if="r.fullAccess === false" :content="r.lockReason || '仅相关人员可查看完整内容'" placement="top">
            <span class="muted scope-chip lock-chip">仅基本信息</span>
          </el-tooltip>
        </div>
        <div class="mt-meta muted">
          <span class="meta-chip"><el-icon><Clock /></el-icon>{{ fmtShort(r.startAt) }} ~ {{ fmt(r.endAt, 'HH:mm') }}</span>
          <span class="meta-chip"><el-icon><User /></el-icon>{{ r.ownerName }}</span>
          <span class="meta-chip"><el-icon><UserFilled /></el-icon>{{ r.participantCount }} 人</span>
          <span v-if="r.myCheckedIn" class="meta-chip ok">已签到{{ r.myCheckinMethod === 'MAKEUP' ? '（补签）' : '' }}</span>
          <span v-else class="meta-chip">签到 {{ r.attendanceCount }}/{{ r.participantCount }}</span>
          <span v-if="r.departmentName" class="meta-chip">{{ r.departmentName }}</span>
          <span v-if="r.projectName" class="meta-chip">{{ r.projectName }}</span>
          <span v-if="r.materialType" class="meta-chip" :class="{ warn: r.materialReady.submitted < r.materialReady.total }">
            材料 {{ r.materialReady.submitted }}/{{ r.materialReady.total }}
          </span>
          <span v-if="r.itemCount" class="meta-chip">条目 {{ r.itemCount }}</span>
        </div>
        <div v-if="r.agenda" class="mt-agenda ellipsis-2">{{ r.agenda }}</div>
        <div v-else-if="r.fullAccess === false" class="muted mt-agenda lock-line">{{ r.lockReason || '仅相关人员可查看议题、材料与纪要' }}</div>
        <div class="mt-actions" @click.stop>
          <el-button size="small" text @click="openDetail(r.id)">详情</el-button>
          <el-button v-if="r.canSelfCheckin" size="small" text type="primary" :loading="checkingId === r.id" @click="checkinFromList(r)">签到</el-button>
          <template v-if="r.canManage">
            <el-button v-if="r.status === 'DRAFT'" size="small" text type="primary" @click="publish(r)">发布</el-button>
            <el-button v-if="r.status === 'DRAFT' || r.status === 'SCHEDULED'" size="small" text @click="openCreate(r)">编辑</el-button>
            <el-button v-if="r.status === 'SCHEDULED'" size="small" text type="primary" @click="setStatus(r, 'IN_PROGRESS')">开始</el-button>
            <el-button v-if="r.status === 'IN_PROGRESS' || r.status === 'MINUTING'" size="small" text type="primary" @click="setStatus(r, 'DONE')">结束</el-button>
            <el-button v-if="r.status !== 'DONE' && r.status !== 'CANCELLED'" size="small" text type="danger" @click="cancel(r)">取消</el-button>
          </template>
        </div>
      </div>
    </div>

      </el-tab-pane>

      <el-tab-pane v-if="auth.isAdmin" label="会议考勤" name="stats">
        <MeetingStatsPanel />
      </el-tab-pane>

      <el-tab-pane v-if="auth.isAdmin || auth.isDeptLeader" label="关联群配置" name="groups">
        <div v-loading="cfgLoading" class="grp-wrap">
          <div class="muted grp-tip">
            为不同层级的会议配置「默认关联钉钉群」：配置好后，发起对应类型的会议会自动带出该群作为「通知钉钉群」，仍可在发起表单里临时改选或清空。公司会由管理员配置，部门会由部门负责人配置本部门，项目会沿用「项目设置」里已绑定的项目群。
          </div>

          <!-- 公司负责人会（仅管理员） -->
          <div v-if="groupCfg.canManageCompany" class="page-card grp-card">
            <div class="grp-h">公司负责人会 · 默认关联群</div>
            <div v-if="groupCfg.company.conversationId" class="grp-bound">
              已关联：<b>{{ groupCfg.company.name || groupCfg.company.conversationId }}</b>
              <el-link type="danger" class="grp-unlink" @click="clearCompanyGroup">取消关联</el-link>
            </div>
            <div class="group-resolve">
              <el-input
                v-model="companyInput"
                placeholder="填写钉钉群名称（需 dws 账号/机器人已在该群）"
                clearable
                :disabled="!!groupCfg.company.conversationId"
              >
                <template #append>
                  <el-button :loading="resolvingCompany" :disabled="!companyInput.trim()" @click="verifyCompanyGroup">验证并关联</el-button>
                </template>
              </el-input>
            </div>
          </div>

          <!-- 部门会议 -->
          <div class="page-card grp-card">
            <div class="grp-h">部门会议 · 各部门默认关联群</div>
            <div v-if="!groupCfg.departments.length" class="muted grp-empty">没有可配置的部门（仅显示你是部门负责人的部门）。</div>
            <div v-for="d in groupCfg.departments" :key="d.id" class="grp-row">
              <span class="grp-dept">{{ d.name }}</span>
              <template v-if="d.conversationId">
                <span class="grp-bound">已关联：<b>{{ d.groupName || d.conversationId }}</b></span>
                <el-link type="danger" class="grp-unlink" @click="clearDeptGroup(d)">取消</el-link>
              </template>
              <div v-else class="group-resolve grp-inline">
                <el-input v-model="d.input" placeholder="填写部门钉钉群名称" clearable :disabled="!!d.saving">
                  <template #append>
                    <el-button :loading="d.saving" :disabled="!(d.input || '').trim()" @click="verifyDeptGroup(d)">验证并关联</el-button>
                  </template>
                </el-input>
              </div>
            </div>
          </div>

          <!-- 项目会议（只读说明） -->
          <div class="page-card grp-card">
            <div class="grp-h">项目会议 · 默认关联群</div>
            <div class="muted grp-tip">
              项目会议的默认群沿用各项目在「项目设置」里绑定的关联钉钉群；发起项目会议时会自动带出所选项目的群。如需修改，请到
              <router-link to="/projects">项目列表</router-link> 对应项目的设置里调整。
            </div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="detail?.title || '会议活动详情'" :size="focusBlock ? '100%' : 'min(680px, 96vw)'">
      <div v-if="detail" v-loading="detailLoading" class="mt-detail" :class="{ 'is-focus': !!focusBlock }">
        <div class="d-row">
          <el-tag :type="STATUS[detail.status]?.type" size="small" effect="dark">{{ STATUS[detail.status]?.label }}</el-tag>
          <el-tag :type="IMPORTANCE[detail.importance]?.type || 'info'" size="small" effect="plain">
            重要性：{{ IMPORTANCE[detail.importance]?.label || '中' }}（{{ IMPORTANCE[detail.importance]?.score || 2 }} 分）
          </el-tag>
          <span class="muted">{{ SCOPE_LABEL[detail.scope] }} · {{ TYPE_LABEL[detail.type] }}</span>
        </div>
        <div class="d-block">
          <div class="d-label">时间</div>
          <div>{{ fmt(detail.startAt, 'YYYY-MM-DD HH:mm') }} ~ {{ fmt(detail.endAt, 'HH:mm') }}</div>
          <div v-if="detail.location" class="muted">地点：{{ detail.location }}</div>
          <div v-if="detail.remindEnabled" class="muted">
            开始提醒：{{ detail.remindBeforeMinutes > 0 ? `提前 ${detail.remindBeforeMinutes} 分钟` : '准点' }}
            <template v-if="detail.startNotifiedAt">（已提醒）</template>
          </div>
        </div>
        <div class="d-block">
          <div class="d-label">发起人</div>
          <div>{{ detail.owner?.name || '—' }}</div>
        </div>
        <!-- 无完整查看权限：只给一把能看懂的锁，不铺内容块 -->
        <div v-if="!full" class="d-block lock-block">
          <div class="d-label">完整内容受限</div>
          <div class="lock-text">{{ detail.lockReason || '仅相关人员可查看完整内容' }}</div>
          <div class="muted tip">议题、会前材料、参会名单、纪要与文档仅对相关人员开放；需要查看请联系发起人或所属部门负责人</div>
        </div>
        <!-- 考勤：自主签到窗口 = 开始时刻 ~ 开始后 1 小时；过后需发起人/管理员/部门主管补签 -->
        <div class="d-block">
          <div class="d-label">
            签到考勤
            <span class="mate-ready">{{ detail.attendance.checked }}/{{ detail.attendance.total }} 已签到</span>
            <span v-if="full" class="mate-ops">
              <el-button v-if="detail.attendance.canSelfCheckin" size="small" type="primary" :loading="checking" @click="doCheckin">我要签到</el-button>
              <el-button v-if="detail.attendance.canMakeupAny" size="small" type="warning" plain @click="mkVisible = true">全员补签</el-button>
              <el-button size="small" text @click="openQr">签到二维码</el-button>
            </span>
          </div>
          <div class="ck-hint muted">
            <template v-if="!full">{{ detail.lockReason || '签到名单与打卡操作仅对相关人员开放' }}</template>
            <template v-else-if="detail.attendance.mine">
              我已签到（{{ detail.attendance.mine.method === 'MAKEUP' ? '补签' : '自主签到' }}）· {{ fmt(detail.attendance.mine.checkedAt, 'MM-DD HH:mm') }}
              <template v-if="detail.attendance.mine.reason">｜理由：{{ detail.attendance.mine.reason }}</template>
            </template>
            <template v-else>{{ checkinHint }}</template>
          </div>
          <div v-if="full && detail.attendance.rows.length" class="ck-list">
            <div v-for="p in detail.attendance.rows" :key="p.userId" class="ck-row">
              <span class="mate-name">{{ p.name }}</span>
              <span class="muted ck-dept">{{ p.departmentName || '—' }}</span>
              <el-tag v-if="p.checked" size="small" :type="p.method === 'MAKEUP' ? 'warning' : 'success'" effect="plain">
                {{ p.method === 'MAKEUP' ? '补签' : '已签到' }}
              </el-tag>
              <el-tag v-else size="small" type="info" effect="plain">未签到</el-tag>
              <span v-if="p.checked" class="muted">{{ fmt(p.checkedAt, 'MM-DD HH:mm') }}</span>
              <span v-if="p.operatorName" class="muted">（{{ p.operatorName }} 补签）</span>
              <span v-if="p.reason" class="ck-reason muted">理由：{{ p.reason }}</span>
              <span class="ck-ops">
                <el-tag
                  v-for="pr in p.praises"
                  :key="pr.id"
                  size="small"
                  effect="plain"
                  class="praise-tag"
                  :closable="detail.canPraise"
                  @close="removePraise(pr.id)"
                >
                  赞 · {{ pr.praiserName }}<template v-if="pr.reason">：{{ pr.reason }}</template>
                </el-tag>
                <el-button v-if="p.canPraise" size="small" text type="primary" @click="openPraise(p)">点赞</el-button>
                <el-button v-if="p.canMakeup" size="small" text type="warning" @click="openMakeup(p)">补签</el-button>
                <el-button v-if="detail.canManage && p.checked" size="small" text type="danger" @click="revokeAttendance(p)">撤销</el-button>
              </span>
            </div>
          </div>
          <div v-else-if="full" class="muted">尚无参会名册</div>
        </div>
        <!-- 活动现场页：管理与对外是同一个页面，抽屉里只留入口 -->
        <div v-if="full" class="d-block">
          <div class="d-label">
            活动现场页
            <span class="mate-ops">
              <el-button size="small" type="primary" :loading="linking" @click="openActivityPage">打开活动现场页</el-button>
              <el-button size="small" @click="openPublicQr">签到二维码</el-button>
              <el-button size="small" text @click="copyPublicLink">复制链接</el-button>
            </span>
          </div>
          <div class="muted tip">
            组织者 / 助教打开这个链接看到的就是管理页（签到、答题加分审批、给个赞、小组得分），陌生人扫码看到的是同一个页面，只是多了姓名手机号签到
          </div>
        </div>

        <div v-if="full" class="d-block">
          <div class="d-label">会议内容 / 议题</div>
          <div class="d-text">{{ detail.agenda }}</div>
        </div>
        <div v-if="full" class="d-block" :class="{ 'd-focus': focusBlock === 'material' }">
          <div class="d-label">
            会前材料
            <span v-if="mate?.total" class="mate-ready">{{ mate.submitted }}/{{ mate.total }} 已就绪</span>
            <span v-if="mate?.missing" class="mate-missing-tag">{{ mate.missing }} 人缺交</span>
            <span class="mate-ops">
              <el-button size="small" text @click="toggleFocus('material')">{{ focusBlock === 'material' ? '收起' : '放大' }}</el-button>
              <el-button
                v-if="detail.canManage && detail.materialType && detail.materialType !== 'TEXT'"
                size="small"
                text
                type="primary"
                :loading="reading"
                @click="readMaterials"
              >
                {{ mate?.submitted ? '重新读取周报' : '读取周报' }}
              </el-button>
            </span>
          </div>
          <div v-if="detail.materialType" class="d-text muted">
            要求：{{ MATERIAL_LABEL[detail.materialType] }}{{ detail.materialRequirement ? `｜${detail.materialRequirement}` : '' }}
          </div>
          <div v-else class="muted">本场会议不要求会前材料（仍可自行提交文字材料备查）</div>

          <!-- 我自己提交/更新文字材料 -->
          <div v-if="mySection" class="mate-mine">
            <div class="mate-mine-h">我的材料<span class="muted">（{{ mySection.departmentName || '—' }}）</span></div>
            <el-input
              v-model="myMaterial"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 10 }"
              placeholder="填写或粘贴本会材料；要求读周报的会议，周报提交后会自动带入，此处手写内容会作为你的材料正文"
            />
            <el-button size="small" type="primary" :loading="submittingMate" @click="submitMyMaterial">提交我的材料</el-button>
          </div>

          <!-- 聚合直排：姓名 · 部门 · 内容，单页可滚动，不逐条点开 -->
          <div v-loading="mateLoading" class="mate-doc">
            <section v-for="s in mate?.sections" :key="s.id" class="mate-sec" :class="{ nocontent: !s.content }">
              <header class="mate-hd">
                <b class="mate-name">{{ s.name }}</b>
                <span class="muted">{{ s.departmentName || '—' }}</span>
                <el-tag :type="s.status === 'SUBMITTED' ? 'success' : s.status === 'MISSING' ? 'danger' : 'info'" size="small" effect="plain">
                  {{ MATE_STATUS[s.status] || s.status }}
                </el-tag>
                <span v-if="s.isSelf" class="muted">我</span>
                <span class="mate-ops">
                  <el-button v-if="detail.canReview" size="small" text type="primary" @click="toggleReview(s.id)">点评</el-button>
                  <el-button v-if="detail.canManage" size="small" text @click="toggleEdit(s)">修改正文</el-button>
                  <el-button
                    v-if="s.isEdited && s.rawContent && (detail.canManage || s.isSelf)"
                    size="small"
                    text
                    @click="showRaw = showRaw === s.id ? '' : s.id"
                  >
                    {{ showRaw === s.id ? '收起原文' : '查看原文' }}
                  </el-button>
                </span>
              </header>
              <div v-if="s.source || s.submittedAt || s.isEdited" class="mate-sub muted">
                来源：{{ s.source === 'REPORT' ? '周报自动读取' : '本人提交' }}
                <template v-if="s.submittedAt">｜{{ fmt(s.submittedAt, 'MM-DD HH:mm') }}</template>
                <template v-if="s.isEdited">｜正文已被主持人修改</template>
              </div>

              <div v-if="editFor === s.id" class="mate-inline">
                <el-input v-model="editText" type="textarea" :autosize="{ minRows: 4, maxRows: 16 }" placeholder="修改后的材料正文（清空则恢复显示原文）" />
                <div class="mate-inline-ops">
                  <el-button size="small" text @click="editFor = ''">取消</el-button>
                  <el-button size="small" type="primary" :loading="savingMate" @click="saveEdit(s)">保存修改</el-button>
                </div>
              </div>
              <pre v-else-if="s.content" class="mate-text">{{ s.content }}</pre>
              <div v-else class="muted">未提交{{ mate?.materialType === 'REPORT_WEEKLY' ? '本周周报' : mate?.materialType === 'REPORT_DAILY' ? '本周日报' : '材料' }}</div>

              <pre v-if="showRaw === s.id && s.rawContent" class="mate-text raw">{{ s.rawContent }}</pre>

              <div v-if="s.reviews?.length" class="mate-reviews">
                <div v-for="rv in s.reviews" :key="rv.id" class="mate-review">
                  <b>{{ rv.reviewerName }}</b>
                  <span class="muted">{{ fmt(rv.createdAt, 'MM-DD HH:mm') }}</span>
                  <span class="rv-text">{{ rv.content }}</span>
                  <el-button
                    v-if="rv.reviewerId === auth.user?.id || detail.canManage"
                    size="small"
                    text
                    type="danger"
                    @click="delReview(rv.id)"
                  >
                    删除
                  </el-button>
                </div>
              </div>
              <div v-if="reviewFor === s.id" class="mate-inline">
                <el-input v-model="reviewText" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="点评意见（独立留痕，不覆盖对方原文）" />
                <div class="mate-inline-ops">
                  <el-button size="small" text @click="reviewFor = ''">取消</el-button>
                  <el-button size="small" type="primary" :loading="savingReview" @click="saveReview(s)">提交点评</el-button>
                </div>
              </div>
            </section>
            <div v-if="!mateLoading && !mate?.sections?.length" class="muted">暂无材料行（发起时选好参会人员会自动建档）</div>
          </div>
          <div class="muted tip">聚合直排：一屏看全员的「姓名 · 部门 · 内容」；点评独立留痕，主持人可会中修改正文且原文保留</div>
        </div>
        <div v-if="full" class="d-block">
          <div class="d-label">会议条目（待办 / 风险 / 待处理）</div>
          <div v-if="!detail.items.length" class="muted">尚无条目（待办录入与 AI 批量拆任务下一阶段开放）</div>
          <div v-else class="item-list">
            <div v-for="i in detail.items" :key="i.id" class="item-row">
              <el-tag size="small" effect="plain">{{ KIND_LABEL[i.kind] }}</el-tag>
              <span class="item-title">{{ i.title }}</span>
              <span class="muted">{{ i.assigneeName || '未指派' }}</span>
              <span v-if="i.dueDate" class="muted">{{ fmt(i.dueDate, 'MM-DD HH:mm') }}</span>
              <el-tag v-if="i.confirmed" size="small" :type="i.taskStatus === 'DONE' ? 'success' : 'warning'" effect="plain">
                {{ i.taskStatus === 'DONE' ? '已完成' : '进行中' }}
              </el-tag>
            </div>
          </div>
        </div>
        <div v-if="full" class="d-block" :class="{ 'd-focus': focusBlock === 'minutes' }">
          <div class="d-label">
            会议纪要
            <el-button size="small" text @click="toggleFocus('minutes')">{{ focusBlock === 'minutes' ? '收起' : '放大' }}</el-button>
            <span class="mate-writer">
              撰写人
              <el-select v-if="detail.canManage" v-model="writerId" size="small" filterable class="writer-sel" @change="saveWriter">
                <el-option v-for="u in users" :key="u.id" :label="`${u.name}${u.department?.name ? ' · ' + u.department.name : ''}`" :value="u.id" />
              </el-select>
              <span v-else class="muted">{{ detail.minutesWriter?.name || detail.owner?.name || '—' }}</span>
            </span>
          </div>
          <template v-if="detail.canManage">
            <el-input v-model="minutesDraft" type="textarea" :rows="4" placeholder="会后填写纪要（P0-d 支持 AI 汇总后人工确认）；保存后可一键发到会议钉钉群" />
            <div class="minutes-ops">
              <el-button size="small" :disabled="!minutesDraft.trim()" @click="saveMinutes(false)">保存纪要</el-button>
              <el-button size="small" type="primary" :disabled="!minutesDraft.trim() || !detail.groupConversationId" @click="saveMinutes(true)">保存并发到群</el-button>
            </div>
            <div v-if="!detail.groupConversationId" class="muted tip">本场会议未绑定钉钉群，可先保存；发起时选好群后即可群发</div>
          </template>
          <div v-else-if="detail.minutes" class="d-text">{{ detail.minutes }}</div>
          <div v-else class="muted">暂无纪要（会后由{{ detail.minutesWriter?.name || '撰写人' }}整理，结束 1 小时未写系统会提醒）</div>
        </div>
        <!-- 文档：在线文字记录 + 多类型附件（发起人 / 管理员 / 参会人均可维护） -->
        <div v-if="full" class="d-block" :class="{ 'd-focus': focusBlock === 'doc' }">
          <div class="d-label">
            活动文档（在线记录 / 附件）
            <el-button size="small" text @click="toggleFocus('doc')">{{ focusBlock === 'doc' ? '收起' : '放大' }}</el-button>
            <span v-if="detail.docUpdatedAt" class="muted doc-meta">
              {{ detail.docUpdatedBy?.name || '—' }} 更新于 {{ fmt(detail.docUpdatedAt, 'MM-DD HH:mm') }}
            </span>
          </div>
          <el-input
            v-model="docDraft"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 16 }"
            :disabled="!canEditDoc"
            placeholder="在线文字记录：议题结论、活动过程、待跟进事项…（参会成员、发起人、管理员可编辑）"
          />
          <div class="doc-ops">
            <el-button
              v-if="canEditDoc"
              size="small"
              type="primary"
              :loading="savingDoc"
              :disabled="docDraft === (detail.docText || '')"
              @click="saveDocDraft"
            >保存文档</el-button>
            <el-button v-if="canEditDoc" size="small" :loading="uploadingFile" @click="pickDocFile">上传附件</el-button>
            <span class="muted tip">支持 Word / Excel / PDF / 图片 / 压缩包等，单个文件不超过 50MB</span>
          </div>
          <input ref="docFileInput" type="file" class="hidden-file" @change="onDocFilePicked" />
          <div v-if="detail.files.length" class="doc-files">
            <div v-for="f in detail.files" :key="f.id" class="doc-file">
              <el-icon><Document /></el-icon>
              <a :href="f.url" target="_blank" rel="noreferrer" class="doc-file-name">{{ f.fileName }}</a>
              <span class="muted">{{ formatBytes(f.size) }}</span>
              <span class="muted">{{ f.uploaderName }}</span>
              <span class="muted">{{ fmt(f.createdAt, 'MM-DD HH:mm') }}</span>
              <el-button v-if="f.canDelete" size="small" text type="danger" @click="removeDocFile(f)">删除</el-button>
            </div>
          </div>
          <div v-else class="muted">尚无附件（可上传会议资料、活动照片、签到表等）</div>
        </div>
        <div v-if="full && detail" class="d-block">
          <div class="d-label">通知与提醒</div>
          <div class="notify-state">
            <el-tag size="small" :type="detail.notifyMode === 'BOTH' || !detail.notifyMode ? 'success' : 'warning'" effect="plain">
              通知方式：{{ MODE_LABEL[detail.notifyMode] || '群发 + 私发' }}
            </el-tag>
            <el-tag size="small" :type="detail.groupNotifiedAt ? 'success' : 'info'" effect="plain">
              {{ detail.groupName ? (detail.groupNotifiedAt ? `已通知「${detail.groupName}」` : `待通知「${detail.groupName}」`) : '未配置钉钉群（只私聊与站内信）' }}
            </el-tag>
            <el-tag size="small" :type="detail.startNotifiedAt ? 'success' : 'info'" effect="plain">
              {{ detail.startNotifiedAt ? `开始提醒已发（${fmt(detail.startNotifiedAt, 'MM-DD HH:mm')}）` : detail.remindEnabled ? '开始提醒：到点自动发' : '开始提醒已关闭' }}
            </el-tag>
            <el-tag size="small" :type="detail.minutesSentAt ? 'success' : 'info'" effect="plain">
              {{ detail.minutesSentAt ? '纪要已发群' : detail.minutes ? '纪要待发群' : '暂无纪要' }}
            </el-tag>
          </div>
          <div v-if="detail.canManage" class="notify-ops">
            <el-button size="small" text @click="previewNotify('INVITE')">预览邀请通知</el-button>
            <el-button v-if="detail.status !== 'DRAFT'" size="small" text @click="previewNotify('START')">预览开始提醒</el-button>
            <el-button v-if="detail.status !== 'DRAFT'" size="small" text @click="resend('INVITE')">重发会议邀请</el-button>
            <el-button v-if="detail.minutes" size="small" text @click="resend('MINUTES')">纪要发到群</el-button>
            <el-button v-if="detail.status === 'IN_PROGRESS'" size="small" text @click="resend('WRAP_UP')">提醒撰写人整理纪要</el-button>
          </div>
          <div class="muted tip">发布/取消/纪要通知由系统异步投递（约 1 分钟内发出）；「预览」只看正文与收件人，不会真的发出</div>
        </div>
      </div>
    </el-drawer>

    <!-- 签到二维码：手机扫码 → 登录后进入详情点「我要签到」 -->
    <el-dialog v-model="qrVisible" :title="qrPublic ? '签到二维码（陌生人可扫）' : '签到二维码'" width="min(360px, 92vw)" align-center>
      <div class="qr-wrap">
        <div class="qr-svg" v-html="qrMarkup" />
        <div class="qr-title">{{ detail?.title }}</div>
        <div class="muted qr-tip">
          <template v-if="qrPublic">
            陌生人扫码后填姓名 + 手机号即可签到，并能看到活动参与情况、小组与个人得分
          </template>
          <template v-else>
            {{ detail ? fmt(detail.startAt, 'MM-DD HH:mm') : '' }} 开始，开始后 1 小时内扫码签到有效；超时请找发起人 / 管理员 / 部门主管补签
          </template>
        </div>
      </div>
    </el-dialog>

    <!-- 全员补签矩阵：按姓名拼音分段点选，名册外的人会自动入册 -->
    <MeetingMakeupGrid v-model="mkVisible" :meeting-id="detail?.id || ''" @changed="onMakeupChanged" />

    <!-- 发起 / 编辑：弹窗；会议与活动是两个对等入口 -->
    <el-dialog
      v-model="formVisible"
      :title="form.id ? '编辑会议活动' : '发起'"
      width="min(720px, 94vw)"
      align-center
      :close-on-click-modal="false"
    >
      <div v-if="!form.id" class="kind-switch">
        <el-button class="kind-btn" :type="isActivity ? 'default' : 'primary'" @click="switchKind('MEETING')">
          <el-icon><Calendar /></el-icon>&nbsp;发起会议
        </el-button>
        <el-button class="kind-btn" :type="isActivity ? 'primary' : 'default'" @click="switchKind('ACTIVITY')">
          <el-icon><Star /></el-icon>&nbsp;发起活动
        </el-button>
      </div>
      <el-form label-position="top" :model="form">
        <el-form-item v-if="!isActivity" label="会议层级">
          <el-radio-group v-model="form.scope" @change="onScopeChange">
            <el-radio-button v-for="s in MEETING_SCOPES" :key="s.value" :value="s.value">{{ s.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-else label="层级">
          <el-tag effect="plain" type="primary">活动</el-tag>
          <span class="muted tip">活动也是一种层级；发起后自动生成现场页链接，扫码即可入场</span>
        </el-form-item>
        <div class="row">
          <el-form-item :label="isActivity ? '活动名称' : '主题'" class="half">
            <el-input
              v-model="form.title"
              :placeholder="isActivity ? '如：产品部季度团建 / 桌游夜' : '如：产品部周会（2026 年第 42 周）'"
            />
          </el-form-item>
          <el-form-item v-if="!isActivity" label="类型" class="half">
            <el-select v-model="form.type" placeholder="选择类型">
              <el-option v-for="t in TYPES" :key="t.value" :label="t.label" :value="t.value" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="重要性">
          <el-radio-group v-model="form.importance">
            <el-radio-button v-for="i in IMPORTANCES" :key="i.value" :value="i.value">
              {{ i.label }}（{{ i.score }} 分）
            </el-radio-button>
          </el-radio-group>
          <div class="muted tip">活跃度按参加次数 × 重要性累加：高 3 分 / 中 2 分 / 低 1 分（默认中）</div>
        </el-form-item>
        <el-form-item v-if="form.scope === 'DEPT'" label="开会部门">
          <el-select v-model="form.deptId" placeholder="选择部门" @change="onScopeChange">
            <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.scope === 'PROJECT'" label="关联项目">
          <el-select v-model="form.projectId" placeholder="选择项目" filterable @change="onScopeChange">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <div class="row">
          <el-form-item label="开始时间" class="half">
            <el-date-picker v-model="form.startAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width: 100%" placeholder="选择开始时间" @change="onStartChange" />
          </el-form-item>
          <el-form-item label="结束时间" class="half">
            <el-date-picker v-model="form.endAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width: 100%" placeholder="选择结束时间" />
          </el-form-item>
        </div>
        <el-form-item label="参会人员">
          <el-select v-model="form.participantIds" multiple filterable placeholder="选择参会人（按层级自动带出，可增减）" class="full">
            <el-option v-for="u in users" :key="u.id" :label="`${u.name}${u.department?.name ? ' · ' + u.department.name : ''}`" :value="u.id" />
          </el-select>
          <div v-if="form.slotId && !form.autoPilot" class="muted tip">该会议来自部门周期周会；首次需要你手动「发布」，之后将自动通知全员</div>
        </el-form-item>
        <el-form-item :label="isActivity ? '活动说明' : '会议内容 / 议题'">
          <el-input
            v-model="form.agenda"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :placeholder="isActivity ? '写清活动内容、流程或规则，参会人能在现场页看到' : '逐条列出议题；周会可写「轮流同步本周进展与下周计划」'"
          />
        </el-form-item>
        <el-form-item v-if="!isActivity" label="会前材料">
          <el-select v-model="form.materialType" class="half">
            <el-option v-for="m in MATERIALS" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
          <el-input
            v-if="form.materialType !== 'NONE'"
            v-model="form.materialRequirement"
            class="rest"
            placeholder="材料要求（如：本周完成事项 + 下周计划 + 需协调问题）"
          />
        </el-form-item>
        <el-form-item label="通知钉钉群">
          <el-select v-model="form.groupConversationId" clearable filterable placeholder="不选则不发群" class="full" @change="onGroupChange">
            <el-option
              v-for="g in groups"
              :key="g.conversationId"
              :label="`${g.groupName}${g.projectNames.length ? '（' + g.projectNames[0] + '）' : ''}`"
              :value="g.conversationId"
            />
          </el-select>
          <div v-if="form.groupConversationId && !form.id" class="muted tip">已按「{{ SCOPE_LABEL[form.scope] }}」的默认关联群自动带出，可改选或清空</div>
          <div class="muted tip">发布时会按下面的「通知方式」投递：钉钉群通知 + 参会人钉钉私聊 + 站内信，约 1 分钟内送达</div>
        </el-form-item>
        <el-form-item label="通知方式">
          <el-radio-group v-model="form.notifyMode">
            <el-radio-button value="BOTH">群发 + 私发</el-radio-button>
            <el-radio-button value="GROUP">只发群</el-radio-button>
            <el-radio-button value="DM">只私发</el-radio-button>
          </el-radio-group>
          <div class="muted tip">只发群不会逐人私聊；只私发不动任何群。站内信始终会发（不影响可追溯）</div>
        </el-form-item>
        <el-form-item v-if="!isActivity" label="会议纪要撰写人">
          <el-select v-model="form.minutesWriterId" filterable clearable placeholder="默认由发起人自己写" class="full">
            <el-option v-for="u in users" :key="u.id" :label="`${u.name}${u.department?.name ? ' · ' + u.department.name : ''}`" :value="u.id" />
          </el-select>
          <div class="muted tip">会议结束 1 小时仍未写纪要，系统会提醒撰写人（同时知会发起人）</div>
        </el-form-item>
        <div class="row">
          <el-form-item label="开始提醒提前量（分钟）" class="half">
            <el-input-number v-model="form.remindBeforeMinutes" :min="0" :max="1440" :step="5" />
          </el-form-item>
          <el-form-item label="地点（可选）" class="half">
            <el-input v-model="form.location" placeholder="如：3 号会议室 / 腾讯会议" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button text @click="formVisible = false">取消</el-button>
        <el-button :loading="saving" @click="submit(false)">保存草稿</el-button>
        <el-button type="primary" :loading="saving" @click="submit(true)">{{ isActivity ? '保存并发布活动' : '保存并发布' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { departmentsApi, meetingsApi, projectsApi, usersApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt, fmtShort, formatBytes } from '../utils/format';
import { qrSvg } from '../utils/qr';
import MeetingStatsPanel from '../components/MeetingStatsPanel.vue';
import MeetingMakeupGrid from '../components/MeetingMakeupGrid.vue';

const auth = useAuthStore();

/** 大 tab：会议与活动 / 会议考勤；与地址栏 ?tab=stats 同步（旧 /admin/meeting-stats 链接重定向进来） */
const route = useRoute();
const router = useRouter();
const tab = ref<'list' | 'stats' | 'groups'>(route.query.tab === 'stats' ? 'stats' : route.query.tab === 'groups' ? 'groups' : 'list');

function onTabChange(name: any) {
  tab.value = name === 'stats' ? 'stats' : name === 'groups' ? 'groups' : 'list';
  if (tab.value === 'groups') loadGroupConfig();
  const q = { ...route.query };
  if (tab.value === 'stats') q.tab = 'stats';
  else if (tab.value === 'groups') q.tab = 'groups';
  else delete q.tab;
  router.replace({ query: q });
}
watch(
  () => route.query.tab,
  (v) => {
    const t: 'list' | 'stats' | 'groups' = v === 'stats' ? 'stats' : v === 'groups' ? 'groups' : 'list';
    if (t !== tab.value) {
      tab.value = t;
      if (t === 'groups') loadGroupConfig();
    }
  },
);

const STATUS: Record<string, { label: string; type: 'info' | 'primary' | 'warning' | 'danger' | 'success' }> = {
  DRAFT: { label: '草稿', type: 'info' },
  SCHEDULED: { label: '已安排', type: 'primary' },
  IN_PROGRESS: { label: '进行中', type: 'warning' },
  MINUTING: { label: '纪要整理', type: 'warning' },
  DONE: { label: '已完成', type: 'success' },
  CANCELLED: { label: '已取消', type: 'info' },
};
/** 会议层级（活动单列，见下方 ACTIVITY） */
const MEETING_SCOPES = [
  { value: 'DEPT', label: '部门周会' },
  { value: 'COMPANY', label: '公司负责人会' },
  { value: 'PROJECT', label: '项目会议' },
  { value: 'PERSONAL', label: '临时会议' },
];
/** 层级筛选：活动也算一种层级 */
const SCOPES = [...MEETING_SCOPES, { value: 'ACTIVITY', label: '活动' }];
const SCOPE_LABEL: Record<string, string> = {
  DEPT: '部门周会',
  COMPANY: '公司负责人会',
  PROJECT: '项目会议',
  PERSONAL: '临时会议',
  ACTIVITY: '活动',
};
const TYPES = [
  { value: 'WEEKLY', label: '周会' },
  { value: 'DAILY', label: '日会/站会' },
  { value: 'PROJECT', label: '项目会' },
  { value: 'REVIEW', label: '评审会' },
  { value: 'OTHER', label: '其他' },
];
const TYPE_LABEL: Record<string, string> = {
  ACTIVITY: '活动',
  WEEKLY: '周会',
  DAILY: '日会/站会',
  PROJECT: '项目会',
  REVIEW: '评审会',
  OTHER: '其他',
};
/** 重要性三档：高 3 分 / 中 2 分 / 低 1 分（默认中） */
const IMPORTANCES = [
  { value: 'HIGH', label: '高', score: 3 },
  { value: 'MEDIUM', label: '中', score: 2 },
  { value: 'LOW', label: '低', score: 1 },
];
const IMPORTANCE: Record<string, { label: string; score: number; type: 'danger' | 'warning' | 'info' }> = {
  HIGH: { label: '高', score: 3, type: 'danger' },
  MEDIUM: { label: '中', score: 2, type: 'warning' },
  LOW: { label: '低', score: 1, type: 'info' },
};
const MATERIALS = [
  { value: 'REPORT_WEEKLY', label: '读取本周周报' },
  { value: 'REPORT_DAILY', label: '读取本周日报' },
  { value: 'TEXT', label: '只填文字材料' },
  { value: 'NONE', label: '不需要材料' },
];
const MATERIAL_LABEL: Record<string, string> = { REPORT_WEEKLY: '读取本周周报', REPORT_DAILY: '读取本周日报', TEXT: '文字材料' };
const MATE_STATUS: Record<string, string> = { PENDING: '待提交', SUBMITTED: '已就绪', MISSING: '缺周报' };
const KIND_LABEL: Record<string, string> = { TODO: '待办', RISK: '风险', PENDING: '待处理' };

/** 「全部」页签对全员开放，内容面由后端逐行判定：fullAccess=false 的行只渲染基本信息 */

const loading = ref(false);
const rows = ref<any[]>([]);
const view = ref('mine');
const scope = ref('');
const keyword = ref('');

const users = ref<any[]>([]);
const departments = ref<any[]>([]);
const projects = ref<any[]>([]);
const groups = ref<any[]>([]);

let timer: any = null;
function debounceLoad() {
  clearTimeout(timer);
  timer = setTimeout(load, 400);
}

async function load() {
  loading.value = true;
  try {
    rows.value = await meetingsApi.list({
      view: view.value,
      scope: scope.value || undefined,
      keyword: keyword.value || undefined,
    });
  } finally {
    loading.value = false;
  }
}

async function loadRefs() {
  const [u, d, p] = await Promise.all([usersApi.list(), departmentsApi.list(), projectsApi.list()]);
  users.value = Array.isArray(u) ? u : (u as any)?.items ?? [];
  departments.value = Array.isArray(d) ? d : [];
  const list = Array.isArray(p) ? p : (p as any)?.items ?? [];
  projects.value = list.filter((x: any) => !x.status || x.status === 'ACTIVE');
  groups.value = await meetingsApi.groupOptions();
}

// ---------- 关联群配置（公司/部门默认群；项目群沿用项目设置） ----------
const cfgLoading = ref(false);
const groupCfg = ref<any>({
  canManageCompany: false,
  company: { conversationId: null, name: null },
  departments: [],
});
const companyInput = ref('');
const resolvingCompany = ref(false);

async function loadGroupConfig() {
  cfgLoading.value = true;
  try {
    const c: any = await meetingsApi.groupConfig();
    groupCfg.value = {
      canManageCompany: !!c.canManageCompany,
      company: { conversationId: c.company?.conversationId ?? null, name: c.company?.name ?? null },
      departments: (c.departments ?? []).map((d: any) => ({ ...d, input: '', saving: false })),
    };
  } finally {
    cfgLoading.value = false;
  }
}

async function verifyCompanyGroup() {
  const name = companyInput.value.trim();
  if (!name) return;
  resolvingCompany.value = true;
  try {
    const r: any = await projectsApi.resolveDingtalkGroup(name);
    await meetingsApi.saveCompanyGroup({ conversationId: r.conversationId, name: r.name });
    groupCfg.value.company = { conversationId: r.conversationId, name: r.name };
    companyInput.value = '';
    groups.value = await meetingsApi.groupOptions();
    ElMessage.success(`公司已关联钉钉群：${r.name}`);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '群校验失败，请稍后重试');
  } finally {
    resolvingCompany.value = false;
  }
}

async function clearCompanyGroup() {
  await meetingsApi.saveCompanyGroup({ conversationId: null });
  groupCfg.value.company = { conversationId: null, name: null };
  groups.value = await meetingsApi.groupOptions();
  ElMessage.success('已取消公司会议关联群');
}

async function verifyDeptGroup(d: any) {
  const name = (d.input || '').trim();
  if (!name) return;
  d.saving = true;
  try {
    const r: any = await projectsApi.resolveDingtalkGroup(name);
    await meetingsApi.saveDeptGroup(d.id, { conversationId: r.conversationId, name: r.name });
    d.conversationId = r.conversationId;
    d.groupName = r.name;
    d.input = '';
    groups.value = await meetingsApi.groupOptions();
    ElMessage.success(`「${d.name}」已关联钉钉群：${r.name}`);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '群校验失败，请稍后重试');
  } finally {
    d.saving = false;
  }
}

async function clearDeptGroup(d: any) {
  d.saving = true;
  try {
    await meetingsApi.saveDeptGroup(d.id, { conversationId: null });
    d.conversationId = null;
    d.groupName = null;
    groups.value = await meetingsApi.groupOptions();
    ElMessage.success(`已取消「${d.name}」的会议关联群`);
  } finally {
    d.saving = false;
  }
}

// ---------- 我的活跃度（参加次数 × 重要性权重） ----------
const myStats = ref<any>(null);

async function loadMyStats() {
  myStats.value = await meetingsApi.statsMe().catch(() => null);
}

/** 'YYYY-MM-DDTHH:mm:ss'（本地挂钟，无时区后缀），el-date-picker 的 value-format 口径 */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// ---------- 详情 ----------
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<any>(null);
/** 详情载荷里 fullAccess 缺省视为可见（旧缓存 / 后端未升级时不至于把内容全锁掉） */
const full = computed(() => detail.value?.fullAccess !== false);
const minutesDraft = ref('');
const MODE_LABEL: Record<string, string> = { BOTH: '群发 + 私发', GROUP: '只发群', DM: '只私发' };

async function openDetail(id: string) {
  detailVisible.value = true;
  detailLoading.value = true;
  focusBlock.value = '';
  try {
    detail.value = await meetingsApi.detail(id);
    minutesDraft.value = detail.value?.minutes ?? '';
    docDraft.value = detail.value?.docText ?? '';
    writerId.value = detail.value?.minutesWriterId ?? detail.value?.ownerId ?? '';
    editFor.value = '';
    reviewFor.value = '';
    showRaw.value = '';
    // 活动现场页：有 token 就直接给入口，没有则在点击时生成
    publicLink.value = detail.value?.publicToken ? `/share/meeting/${detail.value.publicToken}` : '';
    // 保密项目未签协议等情形会被 403 拦住，材料拉不到不影响详情本身
    // 脱敏载荷：材料接口必然 403，干脆不发这个请求
    if (!full.value) mate.value = null;
    else await loadMaterials(id).catch(() => {
      mate.value = null;
    });
  } finally {
    detailLoading.value = false;
  }
}

// ---------- 会前材料聚合（姓名 · 部门 · 内容 直排 + 点评） ----------
const mate = ref<any>(null);
const mateLoading = ref(false);
const reading = ref(false);
const submittingMate = ref(false);
const savingMate = ref(false);
const savingReview = ref(false);
const myMaterial = ref('');
const editFor = ref('');
const editText = ref('');
const reviewFor = ref('');
const reviewText = ref('');
const showRaw = ref('');

async function loadMaterials(id: string) {
  mateLoading.value = true;
  try {
    mate.value = await meetingsApi.materials(id);
    myMaterial.value = (mate.value?.sections ?? []).find((s: any) => s.isSelf)?.content ?? '';
  } finally {
    mateLoading.value = false;
  }
}

/** 我自己的那一段材料（参会人都能在这里手写提交） */
const mySection = computed(() => (mate.value?.sections ?? []).find((s: any) => s.isSelf) ?? null);

async function readMaterials() {
  reading.value = true;
  try {
    const r: any = await meetingsApi.readMaterials(detail.value.id);
    ElMessage.success(`已读取：${r?.read ?? 0} 人带入周报${r?.missing ? `，${r.missing} 人本周未提交` : ''}`);
    await loadMaterials(detail.value.id);
    load();
  } finally {
    reading.value = false;
  }
}

async function submitMyMaterial() {
  const text = myMaterial.value.trim();
  if (!text) return ElMessage.warning('请填写材料内容');
  submittingMate.value = true;
  try {
    await meetingsApi.submitMaterial(detail.value.id, text);
    ElMessage.success('我的材料已提交');
    await loadMaterials(detail.value.id);
    load();
  } finally {
    submittingMate.value = false;
  }
}

function toggleEdit(s: any) {
  reviewFor.value = '';
  showRaw.value = '';
  editFor.value = editFor.value === s.id ? '' : s.id;
  editText.value = s.content ?? '';
}

async function saveEdit(s: any) {
  savingMate.value = true;
  try {
    await meetingsApi.editMaterial(s.id, editText.value);
    editFor.value = '';
    ElMessage.success('材料正文已更新（原文保留可查）');
    await loadMaterials(detail.value.id);
  } finally {
    savingMate.value = false;
  }
}

function toggleReview(id: string) {
  editFor.value = '';
  reviewFor.value = reviewFor.value === id ? '' : id;
  reviewText.value = '';
}

async function saveReview(s: any) {
  const text = reviewText.value.trim();
  if (!text) return ElMessage.warning('请填写点评内容');
  savingReview.value = true;
  try {
    await meetingsApi.reviewMaterial(s.id, text);
    reviewFor.value = '';
    reviewText.value = '';
    await loadMaterials(detail.value.id);
  } finally {
    savingReview.value = false;
  }
}

async function delReview(reviewId: string) {
  await meetingsApi.deleteReview(reviewId);
  await loadMaterials(detail.value.id);
}

// ---------- 考勤：自主签到 / 补签 / 点赞 / 签到二维码 ----------
const checking = ref(false);
/** 列表卡片一键签到的行 id（仅该行转圈）*/
const checkingId = ref('');
/** 详情页当前被「放大」投屏的子块：'' 不放大 / material 会前材料 / minutes 纪要 / doc 文档 */
const focusBlock = ref<'' | 'material' | 'minutes' | 'doc'>('');
const qrVisible = ref(false);
const qrMarkup = ref('');
/** 当前二维码是否为「对外链接”（陌生人可扫）*/
const qrPublic = ref(false);

/** 全员补签矩阵（拼音 A–Z 点选，管理员/发起人/助教/部门主管可用） */
const mkVisible = ref(false);
let mkTimer: any = null;
/** 矩阵里点一下就是一条考勤，连续点选时合并刷新，不每点一次重拉一次详情 */
function onMakeupChanged() {
  clearTimeout(mkTimer);
  mkTimer = setTimeout(async () => {
    if (detail.value) await openDetail(detail.value.id);
    load();
  }, 600);
}
onBeforeUnmount(() => clearTimeout(mkTimer));

/** 当前用户的签到提示文案（窗口内 / 已过窗口） */
const checkinHint = computed(() => {
  const a = detail.value?.attendance;
  if (!a) return '';
  if (!a.total) return '尚无参会名册';
  if (!a.isParticipant) return '你不在本场参会名册，无需签到';
  if (a.selfOpen) return `签到窗口开放中（${fmt(a.windowStart, 'MM-DD HH:mm')} ~ ${fmt(a.windowEnd, 'HH:mm')}）`;
  return '自主签到窗口已关闭（仅开始后 1 小时内有效），如需补签请联系发起人 / 管理员 / 部门主管';
});

async function doCheckin() {
  checking.value = true;
  try {
    const r: any = await meetingsApi.checkin(detail.value.id);
    ElMessage.success(r?.already ? '你已经签到过了' : '签到成功，活跃度已累加');
    await openDetail(detail.value.id);
    load();
  } finally {
    checking.value = false;
  }
}

/** 列表卡片一键签到：无需进详情、无需扫码，直接调自主签到接口 */
async function checkinFromList(r: any) {
  checkingId.value = r.id;
  try {
    const res: any = await meetingsApi.checkin(r.id);
    ElMessage.success(res?.already ? '你已经签到过了' : '签到成功，活跃度已累加');
    r.myCheckedIn = true;
    r.canSelfCheckin = false;
    await load();
  } finally {
    checkingId.value = '';
  }
}

/** 子块页内放大/收起：再次点同一个则收起 */
function toggleFocus(k: 'material' | 'minutes' | 'doc') {
  focusBlock.value = focusBlock.value === k ? '' : k;
}

/** 二维码内容 = 本场会议活动的详情链接，手机扫码 → 登录 → 点「我要签到」 */
function openQr() {
  if (!detail.value) return;
  qrPublic.value = false;
  qrMarkup.value = qrSvg(`${location.origin}/meetings/${detail.value.id}`, { cellSize: 6, margin: 2 });
  qrVisible.value = true;
}

/** 对外链接二维码：陌生人扫码免登录，填姓名 + 手机号签到（没链接就先建） */
async function openPublicQr() {
  if (!publicUrl.value) await ensurePublicLink();
  if (!publicUrl.value) return;
  qrPublic.value = true;
  qrMarkup.value = qrSvg(publicUrl.value, { cellSize: 6, margin: 2 });
  qrVisible.value = true;
}

/** 打开活动现场页：组织者看到的与陌生人看到的是同一个页面，只是多了管理面板 */
async function openActivityPage() {
  if (!publicUrl.value) await ensurePublicLink();
  if (!publicUrl.value) return;
  window.open(publicUrl.value, '_blank', 'noopener');
}

async function openMakeup(p: any) {
  const res = await ElMessageBox.prompt(`为「${p.name}」补签`, '补签考勤', {
    confirmButtonText: '确认补签',
    cancelButtonText: '取消',
    inputType: 'textarea',
    inputPlaceholder: '补签理由（必填）：如 临时外出、设备故障未及时扫码…',
    inputValidator: (v: string) => (String(v ?? '').trim() ? true : '补签必须填写理由'),
  }).catch(() => null);
  if (!res) return;
  await meetingsApi.makeupCheckin(detail.value.id, p.userId, String(res.value).trim());
  ElMessage.success('已补签');
  await openDetail(detail.value.id);
  load();
}

async function openPraise(p: any) {
  const res = await ElMessageBox.prompt(`为「${p.name}」点赞`, '会中表现点赞', {
    confirmButtonText: '点赞',
    cancelButtonText: '取消',
    inputPlaceholder: '点赞理由（可选）：如 方案梳理清晰、主动承担责任…',
  }).catch(() => null);
  if (!res) return;
  await meetingsApi.praise(detail.value.id, p.userId, String(res.value ?? '').trim() || undefined);
  ElMessage.success('已点赞');
  await openDetail(detail.value.id);
}

async function removePraise(praiseId: string) {
  await meetingsApi.removePraise(praiseId);
  ElMessage.success('已撤销点赞');
  await openDetail(detail.value.id);
}

async function revokeAttendance(p: any) {
  const ok = await ElMessageBox.confirm(`撤销「${p.name}」的签到记录？撤销后活跃度会相应扣回。`, '撤销考勤', {
    type: 'warning',
    confirmButtonText: '确认撤销',
    cancelButtonText: '取消',
  }).catch(() => null);
  if (!ok) return;
  await meetingsApi.removeAttendance(detail.value.id, p.userId);
  ElMessage.success('已撤销考勤');
  await openDetail(detail.value.id);
  load();
}

// ---------- 文档：在线文字记录 + 多类型附件 ----------
const docDraft = ref('');
const savingDoc = ref(false);
const uploadingFile = ref(false);
const docFileInput = ref<HTMLInputElement | null>(null);

/** 可编辑文档：发起人 / 管理员 / 参会成员（后端同口径） */
const canEditDoc = computed(() => {
  const d = detail.value;
  if (!d) return false;
  return !!d.canManage || (d.participantIds ?? []).includes(auth.user?.id);
});

async function saveDocDraft() {
  savingDoc.value = true;
  try {
    await meetingsApi.saveDoc(detail.value.id, docDraft.value);
    ElMessage.success('文档已保存');
    await openDetail(detail.value.id);
  } finally {
    savingDoc.value = false;
  }
}

function pickDocFile() {
  docFileInput.value?.click();
}

async function onDocFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) return ElMessage.warning('单个文件请控制在 50MB 以内');
  uploadingFile.value = true;
  try {
    await meetingsApi.uploadDocFile(detail.value.id, file);
    ElMessage.success('附件已上传');
    await openDetail(detail.value.id);
  } finally {
    uploadingFile.value = false;
  }
}

async function removeDocFile(f: any) {
  const ok = await ElMessageBox.confirm(`删除附件「${f.fileName}」？`, '删除附件', { type: 'warning' }).catch(() => null);
  if (!ok) return;
  await meetingsApi.removeDocFile(f.id);
  ElMessage.success('附件已删除');
  await openDetail(detail.value.id);
}

// ---------- 纪要撰写人指派 ----------
// ---------- 活动现场页：管理面板与对外页是同一个页面 ----------
const publicLink = ref('');
const linking = ref(false);

const publicUrl = computed(() => (publicLink.value ? `${location.origin}${publicLink.value}` : ''));

async function ensurePublicLink() {
  if (!detail.value) return;
  linking.value = true;
  try {
    const res = await meetingsApi.publicLink(detail.value.id);
    publicLink.value = res.path;
    ElMessage.success('对外链接已生成，发群里或贴二维码即可');
  } finally {
    linking.value = false;
  }
}

async function copyPublicLink() {
  const url = publicUrl.value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('链接已复制');
  } catch {
    ElMessage.warning(`复制失败，请手动复制：${url}`);
  }
}

const writerId = ref('');

async function saveWriter() {
  if (!detail.value || !writerId.value) return;
  await meetingsApi.update(detail.value.id, { minutesWriterId: writerId.value });
  const name = users.value.find((u: any) => u.id === writerId.value)?.name ?? '';
  ElMessage.success(`已指派 ${name} 撰写纪要；结束 1 小时未写会提醒他`);
  await openDetail(detail.value.id);
}

/** 保存纪要；send=true 时同时投递「纪要发到钉钉群」（异步队列，约 1 分钟内发出） */
async function saveMinutes(send: boolean) {
  const text = minutesDraft.value.trim();
  if (!text) return;
  const r = await meetingsApi.saveMinutes(detail.value.id, text, send);
  ElMessage.success(r?.queued ? '纪要已保存，发到群正在投递（约 1 分钟内）' : '纪要已保存');
  await openDetail(detail.value.id);
  load();
}

const NOTIFY_CN: Record<string, string> = {
  INVITE: '会议邀请（私聊 + 群通知）',
  GROUP: '会议群通知',
  START: '开始提醒',
  CANCEL: '取消通知',
  MINUTES: '会议纪要',
  MATERIAL: '材料催办',
  WRAP_UP: '会后纪要提醒',
  DRAFT_NUDGE: '周会待发布提醒',
};

/** 通知预览（dryRun）：只看正文与解析出的钉钉收件人，不发送、不置幂等位 */
async function previewNotify(kind: string) {
  const r: any = await meetingsApi.notify(detail.value.id, kind, { dryRun: true, force: true });
  const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const parts: string[] = [];
  if (r.skipped) parts.push(`<p>本轮不会发送：${esc(r.reason || '未满足发送条件')}</p>`);
  if (r.group?.text) parts.push(`<p><b>钉钉群 → ${esc(r.group.to)}</b></p><pre>${esc(r.group.text)}</pre>`);
  if (r.dms?.length) {
    parts.push(`<p><b>私聊 ${r.dms.length} 人</b>：${r.dms.map((d: any) => esc(`${d.name}（${d.via}）`)).join('、')}</p>`);
    parts.push(`<pre>${esc(r.dms[0].text)}</pre>`);
  }
  if (!r.group?.text && !r.dms?.length) parts.push('<p>没有可发送的收件人（参会人可能都已停用）</p>');
  await ElMessageBox.alert(parts.join(''), `通知预览：${r.title || ''}`, {
    dangerouslyUseHTMLString: true,
    customClass: 'notify-preview',
    confirmButtonText: '关闭',
  }).catch(() => undefined);
}

/** 手动补发（真实发送走队列，不堵接口） */
async function resend(kind: string) {
  await ElMessageBox.confirm(
    `确认重新发送「${NOTIFY_CN[kind] ?? kind}」？${kind === 'MINUTES' ? '将把当前纪要正文摘要发到会议钉钉群。' : '参会人会再次收到钉钉私聊。'}`,
    '补发会议通知',
    { type: 'warning', confirmButtonText: '确认发送', cancelButtonText: '再想想' },
  ).catch(() => null).then(async (res) => {
    if (!res) return;
    const r: any = await meetingsApi.notify(detail.value.id, kind, { force: true });
    ElMessage.success(r?.queued ? `${NOTIFY_CN[kind] ?? kind}已投递，约 1 分钟内发出` : `${NOTIFY_CN[kind] ?? kind}已发送`);
    await openDetail(detail.value.id);
    load();
  });
}

// ---------- 发起 / 编辑 ----------
const formVisible = ref(false);
const saving = ref(false);
const form = ref<any>({
  id: '',
  scope: 'DEPT',
  title: '',
  type: 'WEEKLY',
  importance: 'MEDIUM',
  deptId: null,
  projectId: null,
  slotId: null,
  autoPilot: false,
  startAt: '',
  endAt: '',
  agenda: '',
  location: '',
  participantIds: [] as string[],
  materialType: 'REPORT_WEEKLY',
  materialRequirement: '',
  groupConversationId: null,
  groupName: '',
  remindBeforeMinutes: 0,
  notifyMode: 'BOTH',
  minutesWriterId: null as string | null,
});

/** 当前是不是发起活动：活动用活动名称 + 活动说明，不需要会前材料与纪要 */
const isActivity = computed(() => form.value.scope === 'ACTIVITY');

/** 会议 / 活动两个对等入口互切 */
async function switchKind(kind: 'MEETING' | 'ACTIVITY') {
  if (form.value.id) return;
  if (kind === 'ACTIVITY') {
    form.value.scope = 'ACTIVITY';
    form.value.type = 'ACTIVITY';
    form.value.materialType = 'NONE';
    form.value.materialRequirement = '';
    form.value.minutesWriterId = null;
    // 活动默认现在开始，持续 2 小时，扫码即可签到
    const s = new Date();
    s.setSeconds(0, 0);
    form.value.startAt = toLocalInput(s);
    form.value.endAt = toLocalInput(new Date(s.getTime() + 2 * 3600_000));
  } else {
    form.value.scope = 'DEPT';
    form.value.deptId = form.value.deptId || auth.user?.departmentId || null;
  }
  await onScopeChange();
  if (kind === 'ACTIVITY') form.value.type = 'ACTIVITY';
}

/** 默认开始时间：下一个未过整点（当天 +2h），结束 +1h */
function defaultRange() {
  const s = new Date();
  s.setMinutes(0, 0, 0);
  s.setHours(s.getHours() + 2);
  const e = new Date(s.getTime() + 3600_000);
  form.value.startAt = toLocalInput(s);
  form.value.endAt = toLocalInput(e);
}

async function openCreate(row?: any) {
  await loadRefs();
  if (row) {
    const d = await meetingsApi.detail(row.id);
    form.value = {
      id: d.id,
      scope: d.scope,
      title: d.title,
      type: d.type,
      importance: d.importance || 'MEDIUM',
      deptId: d.department?.id ?? null,
      projectId: d.project?.id ?? null,
      slotId: d.slotId ?? null,
      autoPilot: false,
      startAt: toLocalInput(new Date(d.startAt)),
      endAt: toLocalInput(new Date(d.endAt)),
      agenda: d.agenda ?? '',
      location: d.location ?? '',
      participantIds: d.participantIds ?? [],
      materialType: d.materialType || 'NONE',
      materialRequirement: d.materialRequirement || '',
      groupConversationId: d.groupConversationId || null,
      groupName: d.groupName || '',
      remindBeforeMinutes: d.remindBeforeMinutes ?? 0,
      notifyMode: d.notifyMode || 'BOTH',
      minutesWriterId: d.minutesWriterId ?? null,
    };
  } else {
    form.value = {
      ...form.value,
      id: '',
      scope: 'DEPT',
      type: 'WEEKLY',
      title: '',
      agenda: '',
      location: '',
      importance: 'MEDIUM',
      materialType: 'REPORT_WEEKLY',
      materialRequirement: '',
      deptId: form.value.deptId ?? auth.user?.departmentId ?? null,
      projectId: null,
      slotId: null,
      autoPilot: false,
      groupConversationId: null,
      groupName: '',
      participantIds: [],
      notifyMode: 'BOTH',
      minutesWriterId: null,
    };
    defaultRange();
    await onScopeChange();
  }
  formVisible.value = true;
}

/** 层级/部门/项目变化 → 拉模板带出名称、时间、参会人、群 */
async function onScopeChange() {
  if (form.value.id) return; // 编辑态不覆盖已存数据
  const t = await meetingsApi.template({
    scope: form.value.scope,
    deptId: form.value.deptId || undefined,
    projectId: form.value.projectId || undefined,
  });
  form.value.title = t.title;
  form.value.type = t.type;
  form.value.materialType = t.materialType;
  form.value.materialRequirement = t.materialRequirement || '';
  form.value.groupConversationId = t.groupConversationId || null;
  form.value.groupName = t.groupName || '';
  form.value.slotId = t.slotId || null;
  form.value.autoPilot = !!t.autoPilot;
  form.value.remindBeforeMinutes = t.remindBeforeMinutes ?? 0;
  form.value.participantIds = t.participantIds || [];
  if (form.value.scope === 'PROJECT' && t.projectId) form.value.projectId = t.projectId;
  if ((form.value.scope === 'DEPT' || form.value.scope === 'COMPANY') && t.weekday && form.value.startAt) {
    applyWeekday(t.weekday, t.time, t.durationMinutes ?? 60);
  }
}

/** 按周期位把已选日期调整到「本周该星期」并套用时间点 */
function applyWeekday(weekday: number, hhmm: string | null, duration: number) {
  if (!form.value.startAt) return;
  const s = new Date(form.value.startAt);
  const target = ((weekday % 7) + 7) % 7; // 1=周一 … 0=周日
  const cur = s.getDay();
  s.setDate(s.getDate() + ((target - cur + 7) % 7));
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    s.setHours(h, m, 0, 0);
  }
  const e = new Date(s.getTime() + duration * 60_000);
  form.value.startAt = toLocalInput(s);
  form.value.endAt = toLocalInput(e);
}

function onStartChange() {
  if (!form.value.startAt) return;
  const s = new Date(form.value.startAt);
  const dur = form.value.endAt && new Date(form.value.endAt) > s ? new Date(form.value.endAt).getTime() - s.getTime() : 3600_000;
  form.value.endAt = toLocalInput(new Date(s.getTime() + dur));
}

function onGroupChange(cid: any) {
  const g = groups.value.find((x) => x.conversationId === cid);
  form.value.groupName = g?.groupName ?? '';
}

async function submit(publish: boolean) {
  const act = isActivity.value;
  if (!form.value.title?.trim()) return ElMessage.warning(act ? '请填写活动名称' : '请填写会议主题');
  if (!form.value.agenda?.trim()) return ElMessage.warning(act ? '请填写活动说明' : '请填写会议内容/议题');
  if (!form.value.startAt || !form.value.endAt) return ElMessage.warning(act ? '请选择活动时间' : '请选择会议时间');
  if (!form.value.participantIds?.length) return ElMessage.warning('请选择参会人员');
  if (new Date(form.value.endAt).getTime() <= new Date(form.value.startAt).getTime()) {
    return ElMessage.warning('结束时间需晚于开始时间');
  }
  saving.value = true;
  const f = form.value;
  // 只提交表单字段；前端本地挂钟 → 带 Z 的 ISO，服务端按绝对时刻存储，展示时按本地时区还原
  const payload = {
    title: f.title,
    scope: f.scope,
    type: act ? 'ACTIVITY' : f.type,
    importance: f.importance || 'MEDIUM',
    agenda: f.agenda,
    location: f.location,
    deptId: f.scope === 'DEPT' ? f.deptId : null,
    projectId: f.scope === 'PROJECT' ? f.projectId : null,
    slotId: f.slotId ?? null,
    participantIds: f.participantIds,
    materialType: f.materialType,
    materialRequirement: f.materialRequirement,
    groupConversationId: f.groupConversationId,
    groupName: f.groupName,
    remindEnabled: true,
    remindBeforeMinutes: Number(f.remindBeforeMinutes) || 0,
    notifyMode: f.notifyMode || 'BOTH',
    minutesWriterId: f.minutesWriterId || null,
    startAt: new Date(f.startAt).toISOString(),
    endAt: new Date(f.endAt).toISOString(),
    publish,
  };
  try {
    if (f.id) {
      await meetingsApi.update(f.id, payload);
      if (publish) await meetingsApi.publish(f.id);
      ElMessage.success(act ? '活动已更新' : '会议已更新');
      formVisible.value = false;
      await load();
      return;
    }
    const created: any = await meetingsApi.create(payload);
    ElMessage.success(
      act
        ? publish
          ? '活动已发布，现场页链接已生成'
          : '活动草稿已保存'
        : publish
          ? '会议已发布，邀请与群通知正在发出（约 1 分钟内送达）'
          : '草稿已保存',
    );
    formVisible.value = false;
    await load();
    // 活动：直接打开现场页入口（详情抽屉）+ 弹签到二维码，现场扫码即入场
    if (act && created?.id) {
      await openDetail(created.id);
      if (publish) await openPublicQr();
    }
  } finally {
    saving.value = false;
  }
}

async function publish(r: any) {
  const res: any = await meetingsApi.publish(r.id);
  ElMessage.success(res?.notified ? '会议已发布，邀请与群通知正在发出（约 1 分钟内送达）' : '会议已发布');
  load();
}

async function setStatus(r: any, status: string) {
  await meetingsApi.setStatus(r.id, status);
  ElMessage.success(status === 'IN_PROGRESS' ? '会议已开始' : '会议已结束');
  load();
}

async function cancel(r: any) {
  const res = await ElMessageBox.prompt('取消原因（可选）', `取消会议「${r.title}」`, {
    confirmButtonText: '确认取消',
    cancelButtonText: '再想想',
    inputPlaceholder: '如：与外部客户时间冲突',
  }).catch(() => null);
  if (!res) return; // 点了「再想想」
  await meetingsApi.cancel(r.id, res.value || undefined);
  ElMessage.success('会议已取消');
  load();
}

onMounted(async () => {
  await loadRefs();
  await loadMyStats();
  await load();
  if (tab.value === 'groups') await loadGroupConfig();
  await applyRoute();
});

// ---------- 深链入口（站内信/钉钉都带 /meetings/{id}；项目页发起入口走 ?create） ----------

/** 根据地址栏决定要不要自动弹开详情抽屉或发起抽屉 */
async function applyRoute() {
  const id = String(route.params.id || route.query.meeting || '');
  if (id) {
    await openDetail(id);
    return;
  }
  const sc = String(route.query.create || '');
  if (sc) await openCreateFrom(sc, String(route.query.projectId || ''), String(route.query.deptId || ''));
}

/** 从项目页/部门页过来：先开好抽屉，再把层级与关联对象填上并重拉模板 */
async function openCreateFrom(sc: string, projectId: string, deptId: string) {
  await openCreate();
  form.value.scope = sc;
  if (projectId) form.value.projectId = projectId;
  if (deptId) form.value.deptId = deptId;
  await onScopeChange();
}

// 同一页面复用时（/meetings/:id 之间跳转）靠 watch 重开抽屉
watch(
  () => [route.params.id, route.query.meeting, route.query.create],
  async () => {
    await applyRoute();
  },
);

// 抽屉关掉后把地址回到列表页，避免 /meetings/xxx 刷新时又弹出来
watch(detailVisible, (v) => {
  if (!v) {
    focusBlock.value = '';
    if (route.params.id) router.replace('/meetings');
  }
});

// 放大投屏时按 ESC 退出
function onEscFocus(e: KeyboardEvent) {
  if (e.key === 'Escape' && focusBlock.value) focusBlock.value = '';
}
onMounted(() => window.addEventListener('keydown', onEscFocus));
onBeforeUnmount(() => window.removeEventListener('keydown', onEscFocus));
</script>

<style scoped>
/* 大 tab 与内容的间距由 styles.css 统一为 --sp-3，不再局部覆盖 */
.kind-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 14px;
}
.kind-btn {
  width: 100%;
  height: 38px;
}
.filter-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.scope-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.kw {
  max-width: 320px;
}
.mt-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 120px;
}
.mt-card {
  cursor: pointer;
}
.mt-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mt-title {
  font-size: var(--fs-lg);
  flex: 1;
  min-width: 0;
}
.scope-chip {
  font-size: 12px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  padding: 0 6px;
  flex-shrink: 0;
}
.mt-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
  font-size: 12px;
}
.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.meta-chip.warn {
  color: #e6a23c;
}
.mt-agenda {
  margin-top: 8px;
  color: #606266;
  font-size: 13px;
}
/* 内容面受限：列表与详情都用同一把“锁”的视觉，避免只有一块空白让人以为没数据 */
.lock-chip {
  color: #e6a23c;
  border-color: #f3d19e;
  background: #fdf6ec;
}
.lock-line {
  color: #b1b3b8;
  font-style: normal;
}
.lock-block {
  background: #fdf6ec;
  border: 1px solid #f3d19e;
  border-radius: 6px;
  padding: 10px 12px;
}
.lock-text {
  color: #b88230;
  font-size: 13px;
}
.visibility-tip {
  font-size: 12px;
  line-height: 1.5;
}
.mt-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
  border-top: 1px dashed var(--app-border);
  padding-top: 6px;
}
.ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.d-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.d-block {
  margin-bottom: 14px;
}
/* 页内放大（投屏）：只看被放大的那一块，字体放大、正文居中限宽；其余子块隐去 */
.mt-detail.is-focus .d-block:not(.d-focus) {
  display: none;
}
.d-block.d-focus {
  max-width: 1080px;
  margin: 0 auto 14px;
}
.mt-detail.is-focus .d-label {
  font-size: var(--fs-lg);
}
.mt-detail.is-focus .d-text,
.mt-detail.is-focus .mate-text {
  font-size: var(--fs-xl);
  line-height: 1.9;
}
.mt-detail.is-focus .mate-name {
  font-size: 20px;
}
.mt-detail.is-focus :deep(.el-textarea__inner) {
  font-size: var(--fs-md);
}
.notify-state {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.notify-ops {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.minutes-ops {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.d-label {
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.d-text {
  white-space: pre-wrap;
  color: #303133;
  background: #f7f9fc;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.6;
}
.mate-list,
.item-list {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
}
.mate-row,
.item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--app-border);
  font-size: 13px;
}
.mate-row:last-child,
.item-row:last-child {
  border-bottom: none;
}
.mate-name {
  font-weight: 500;
  min-width: 64px;
}
/* ---------- 会前材料聚合直排（姓名 · 部门 · 内容） ---------- */
.mate-ready {
  margin-left: 8px;
  font-size: 12px;
  color: #2e7d32;
  font-weight: 500;
}
.mate-missing-tag {
  margin-left: 6px;
  font-size: 12px;
  color: #c62828;
}
.mate-ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.mate-writer {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--app-text-muted, #606266);
}
.writer-sel {
  width: 150px;
}
.mate-mine {
  margin-top: 8px;
  padding: 10px;
  border: 1px dashed var(--app-border);
  border-radius: 8px;
  background: #fafbfd;
}
.mate-mine-h {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}
.mate-mine .el-button {
  margin-top: 8px;
}
.mate-doc {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 40px;
}
.mate-sec {
  border: 1px solid var(--app-border);
  border-left: 3px solid #4a7fd6;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.mate-sec.nocontent {
  border-left-color: #dcdfe6;
  background: #fafafa;
}
.mate-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mate-sub {
  font-size: 12px;
  margin-top: 2px;
}
.mate-text {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
.mate-text.raw {
  margin-top: 6px;
  padding: 8px 10px;
  background: #f7f9fc;
  border-radius: 6px;
  color: #606266;
  font-size: 12px;
}
.mate-inline {
  margin-top: 8px;
}
.mate-inline-ops {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.mate-reviews {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mate-review {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.mate-review .rv-text {
  flex: 1;
  min-width: 0;
  color: #b26a00;
  white-space: pre-wrap;
}
.item-title {
  flex: 1;
  min-width: 0;
}
.tip {
  font-size: 12px;
  margin-top: 4px;
}
.row {
  display: flex;
  gap: 12px;
}
.half {
  flex: 1;
  min-width: 0;
}
.full {
  width: 100%;
}
.rest {
  flex: 1;
  margin-left: 8px;
}
/* ---------- 我的活跃度 ---------- */
.my-score {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: var(--app-text-muted, #606266);
}
.my-score b {
  color: #2e7d32;
  font-size: 14px;
}
/* ---------- 签到考勤 ---------- */
.ck-hint {
  font-size: 12px;
  margin-bottom: 6px;
}
.ck-list {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
}
.ck-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-bottom: 1px solid var(--app-border);
  font-size: 12px;
}
.ck-row:last-child {
  border-bottom: none;
}
.ck-dept {
  min-width: 60px;
}
.ck-reason {
  color: #b26a00;
}
.ck-ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.praise-tag {
  border-color: #f0c36d;
  color: #b26a00;
  background: #fffaf0;
}
/* ---------- 文档（在线记录 + 附件） ---------- */
.doc-meta {
  font-size: 12px;
  font-weight: 400;
}
.doc-ops {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hidden-file {
  display: none;
}
.doc-files {
  margin-top: 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
}
.doc-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--app-border);
  font-size: 12px;
}
.doc-file:last-child {
  border-bottom: none;
}
.doc-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #2f6fd0;
  text-decoration: none;
}
.doc-file-name:hover {
  text-decoration: underline;
}
/* ---------- 签到二维码 ---------- */
.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.qr-svg :deep(svg) {
  width: 240px;
  height: 240px;
}
.qr-title {
  font-weight: 600;
  text-align: center;
}
.qr-tip {
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
/* ---------- 活动互动：对外链接 / 助教 / 答题 / 加分 / 小组 PK ---------- */
.quick-act {
  margin-left: 8px;
}
.act-link {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.act-link-input :deep(.el-input-group__append) {
  padding: 0 12px;
}
.act-open {
  font-size: 12px;
  color: #2f6fd0;
  text-decoration: none;
}
.act-open:hover {
  text-decoration: underline;
}
.act-sec {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--app-border);
}
.act-sec-h {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.act-sec-h .muted {
  font-size: 12px;
  font-weight: 400;
}
.act-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.act-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.act-sel {
  width: 200px;
}
.act-reason {
  width: 200px;
}
.act-quiz {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.act-pending {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 5px 0;
  font-size: 13px;
}
.act-pending-points {
  color: #f56c6c;
  font-weight: 700;
}
.act-pending-reason {
  flex: 1;
  min-width: 80px;
}
.act-group {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 10px;
  background: #fafbff;
  margin-bottom: 6px;
}
.act-group-rank {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: 50%;
  background: #e6ecff;
  color: #2f6fd0;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.act-group-rank.hot {
  background: #ffb02e;
  color: #fff;
}
.act-group-main {
  flex: 1;
  min-width: 0;
}
.act-group-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.act-group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.act-group-score {
  font-size: 20px;
  font-weight: 800;
  color: #2f6fd0;
}
.act-group-ops {
  margin-top: 10px;
}
.act-people {
  display: flex;
  flex-direction: column;
}
.act-person {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 2px;
  border-bottom: 1px dashed var(--app-border);
  font-size: 13px;
}
.act-person:last-child {
  border-bottom: none;
}
.act-person-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.act-person-score {
  font-weight: 700;
  color: #2f6fd0;
}

/* ---------- 手机浏览器适配 ---------- */
@media (max-width: 640px) {
  .page-title {
    flex-wrap: wrap;
    gap: 8px;
  }
  .page-title .my-score {
    width: 100%;
    font-size: 12px;
    line-height: 1.6;
  }
  .quick-act {
    margin-left: 0;
  }
  .filter-card {
    padding: 10px;
  }
  .scope-bar {
    flex-wrap: wrap;
  }
  .kw {
    width: 100%;
  }
  .mt-card {
    padding: 10px;
  }
  .mt-head {
    flex-wrap: wrap;
  }
  .mt-title {
    flex: 1 1 100%;
    font-size: 15px;
  }
  .mt-meta {
    flex-wrap: wrap;
    gap: 6px;
  }
  .mt-actions {
    flex-wrap: wrap;
    gap: 4px;
  }
  .mt-detail {
    font-size: 13px;
  }
  .mate-hd {
    flex-wrap: wrap;
  }
  .act-sel,
  .act-reason {
    width: 100%;
  }
  .act-group {
    flex-wrap: wrap;
  }
  .act-group-score {
    font-size: 17px;
  }
  .qr-svg :deep(svg) {
    width: 200px;
    height: 200px;
  }
}
.grp-wrap {
  max-width: 860px;
}
.grp-tip {
  line-height: 1.7;
  margin-bottom: 12px;
}
.grp-card {
  margin-bottom: 14px;
}
.grp-h {
  font-size: var(--fs-lg);
  font-weight: 600;
  margin-bottom: 10px;
}
.grp-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid #f0f0f0;
}
.grp-dept {
  min-width: 120px;
  font-weight: 500;
}
.grp-inline {
  flex: 1;
}
.grp-bound {
  color: #2e7d32;
}
.grp-unlink {
  margin-left: 10px;
}
.grp-empty {
  padding: 6px 0;
}
</style>
