<template>
  <div class="page">
    <div class="page-title-row">
      <div class="page-title">工作管理</div>
      <el-button v-if="canViewTeam" size="small" plain type="primary" @click="goCompanyWeekly">
        <el-icon><DocumentCopy /></el-icon>&nbsp;公司/部门周报聚合
      </el-button>
    </div>

    <!-- 大 tab：日报 / 周报 / PBC / 日报看板 / 工时统计 / 我的工作时间，点 tab 直达对应区块，不用整页往下翻 -->
    <el-tabs v-model="tab" class="rm-tabs" @tab-change="onTabChange">
      <el-tab-pane label="日报" name="daily" />
      <el-tab-pane label="周报" name="weekly" />
      <el-tab-pane label="PBC 月计划" name="pbc" />
      <el-tab-pane label="日报看板" name="board" />
      <el-tab-pane label="工时统计" name="hours" />
      <el-tab-pane label="我的实践/培训时间" name="schedule" />
      <!-- 待我审核：项目审批 + PBC 计划审批 + PBC 考核评分聚合（仅管理员/部门负责人，成员不展示） -->
      <el-tab-pane v-if="auth.isAdmin || auth.isDeptLeader" label="待我审核" name="review" />
    </el-tabs>

    <!-- 日报看板 / 工时统计：整宽面板，不需要右侧栏 -->
    <ReportsStatsPanel v-if="tab === 'board'" mode="board" />
    <ReportsStatsPanel v-else-if="tab === 'hours'" mode="hours" />

    <!-- 我的工作时间：整宽 TAB（原右栏卡片迁入，首页也复用同一组件） -->
    <WorkSchedulePanel v-else-if="tab === 'schedule'" :show-manage-link="false" />

    <!-- 待我审核：项目审批 / PBC 计划审批 / PBC 考核评分聚合清单，点行直达对应审核入口 -->
    <PendingReviewPanel v-else-if="tab === 'review'" @jump="onReviewJump" />

    <!-- 日报 / 周报 / PBC：左侧填写 + 历史文档（原右栏工作时间已改为独立 TAB） -->
    <div v-else>

    <!-- 写日报 / 生成周报 / PBC 填写区 -->
    <div class="page-card">

      <!-- 视角切换：仅管理员/部门负责人可切到「团队成员」查看下属的日报/周报/PBC -->
      <div v-if="canViewTeam" class="viewer-toggle">
        <el-radio-group v-model="viewerMode" size="small" @change="onViewerChange">
          <el-radio-button value="me">我的</el-radio-button>
          <el-radio-button value="team">团队成员</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 日报：三段式手写提交（文字/语音直接提交，AI 自动归段整理并更新项目进展） -->
      <template v-if="viewerMode === 'me' && type === 'DAILY'">
        <div class="sec-item">
          <div class="sec-label">【已完成的工作】</div>
          <el-input
            v-model="dailyDone"
            type="textarea"
            :rows="3"
            placeholder="今天完成了什么？打字或按住麦克风说话（语音会追加到本段）…顺便带一句今天干了几个小时（如「今天投入 8 小时」），系统会自动统计工时并参加每周排名"
          />
        </div>
        <div class="sec-item">
          <div class="sec-label">【后续计划】<span class="muted sec-optional">（可选）</span></div>
          <el-input v-model="dailyPlan" type="textarea" :rows="2" placeholder="接下来计划做什么…" />
        </div>
        <div class="sec-item">
          <div class="sec-label">【需要协调的问题】<span class="muted sec-optional">（可选）</span></div>
          <el-input v-model="dailyIssue" type="textarea" :rows="2" placeholder="需要同事或负责人协调的问题…" />
        </div>
        <div class="sec-item hours-line">
          <div class="sec-label">
            当日工时<span class="hours-required">*</span><span class="muted sec-optional">（小时，必填）</span>
          </div>
          <div class="hours-line-row">
            <el-input-number
              v-model="dailyHours"
              :min="0"
              :max="24"
              :step="0.5"
              :precision="1"
              controls-position="right"
              placeholder="如 8"
              style="width: 130px"
            />
            <span class="muted hours-tip">必须上报今天干了多少小时；确实没投入就填 0（漏填按 0 小时记录）</span>
          </div>
        </div>
        <div class="daily-actions">
          <el-button
            :type="listening ? 'danger' : 'default'"
            :class="{ 'voice-pulse': listening }"
            :disabled="!srSupported"
            circle
            title="按住说话，松开结束（内容追加到「已完成的工作」）"
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
          <el-button type="primary" :loading="submittingDaily" @click="submitDaily">提交日报</el-button>
        </div>
        <!-- 提交后 AI 整理结果 -->
        <div v-if="lastResult" class="ai-result">
          <div class="edit-title">AI 整理结果</div>
          <div class="corrected-text">{{ lastResult.correctedContent || lastResult.rawContent }}</div>
          <div class="muted proj-line">
            所属项目：
            <el-tag v-if="lastResult.project" size="small" type="success" effect="plain">
              {{ lastResult.project.name }}
            </el-tag>
            <span v-else>无法判断（未更新项目进展）</span>
          </div>
          <div class="muted proj-line">
            当日工时：
            <el-tag v-if="lastResult.hours" size="small" type="warning" effect="plain">{{ lastResult.hours }} 小时</el-tag>
            <span v-else class="muted">未识别到（在日报里写一句「今天干了 X 小时」即可，也可点开本条日报详情补填）</span>
          </div>
          <div v-if="lastResult.backfill?.length" class="backfill-line">
            已补录：
            <el-tag v-for="(b, i) in lastResult.backfill" :key="i" size="small" type="warning" effect="plain">
              {{ b.label }}{{ b.type === 'DAILY' ? '日报' : '周报' }}（{{ b.date }}）
            </el-tag>
          </div>
        </div>
      </template>

      <!-- PBC（我的）：计划填写 / 我的自评 / 待我审核 / 排行榜 -->
      <template v-else-if="viewerMode === 'me' && type === 'PBC'">
        <div class="form-row">
          <el-date-picker
            v-model="pbcMonth"
            type="month"
            value-format="YYYY-MM"
            placeholder="选择月份"
            :clearable="false"
            class="date-sel"
            @change="onPbcMonthChange"
          />
          <el-tag :type="PBC_STATUS_TYPE[pbcStatus]" size="small" effect="plain">{{ PBC_STATUS_LABEL[pbcStatus] }}</el-tag>
          <el-tag v-if="showSelfCols" :type="REVIEW_STATUS_TYPE[reviewStatus]" size="small" effect="plain">考核：{{ REVIEW_STATUS_LABEL[reviewStatus] }}</el-tag>
          <span class="muted tip">自评不限时间，历史月份也能补录；最终得分以上级复核为准</span>
        </div>
        <div class="pbc-viewswitch" style="margin: 6px 0 12px">
          <el-radio-group v-model="pbcView" size="small" @change="onPbcViewChange">
            <el-radio-button value="plan">我的计划</el-radio-button>
            <el-radio-button value="self">我的自评</el-radio-button>
            <el-radio-button v-if="showReviewTab" value="review">
              待我审核<template v-if="reviewPending">（{{ reviewPending }}）</template>
            </el-radio-button>
            <el-radio-button value="rank">排行榜</el-radio-button>
          </el-radio-group>
        </div>

        <!-- 待我审核：上级复核工作台（只对有审核任务的人显示） -->
        <PbcReviewPanel v-if="pbcView === 'review'" @reviewed="onReviewDone" />
        <PbcRanking v-else-if="pbcView === 'rank'" :month="pbcMonth" />

        <!-- 我的计划：填写事项与分值（合计 100），保存即提交审批 -->
        <template v-else-if="pbcView === 'plan'">
          <el-alert
            v-if="!pbcLocked && !planWindowOpen"
            class="pbc-lock-alert"
            type="warning"
            :closable="false"
            show-icon
            title="当前不在本月计划填写时间窗口"
            :description="planWindowHint || '当月计划需在 1~10 号填写/提交；历史月份可随时补录（管理员不受限）'"
          />
          <el-alert v-if="planEditable" class="pbc-guide" type="info" :closable="false" show-icon title="填写要求">
            <ol class="pbc-guide-list">
              <li>每一条内容具体、可衡量、可达到、可展示；</li>
              <li>内容和项目目标或团队目标紧密相关。</li>
            </ol>
          </el-alert>
          <el-alert
            v-if="pbcLocked"
            class="pbc-lock-alert"
            type="success"
            :closable="false"
            show-icon
            :title="`本月 PBC 已由${pbcApprover ? `「${pbcApprover}」` : '负责人'}审批通过并锁定`"
            description="如需修改，请联系审批人点击「允许修改」后重新编辑。"
          />
          <el-alert
            v-if="pbcStatus === 'REJECTED' && pbcReviewComment"
            class="pbc-lock-alert"
            type="warning"
            :closable="false"
            show-icon
            :title="`本月 PBC 已被${pbcReviewer ? `「${pbcReviewer}」` : '负责人'}退回修改，请根据以下意见调整并重新提交`"
          >
            <div class="pbc-review-comment">{{ pbcReviewComment }}</div>
          </el-alert>
          <el-table :data="pbcItems" class="pbc-table" v-loading="pbcLoading">
            <el-table-column label="计划完成的事项" min-width="240">
              <template #default="{ row }">
                <el-input v-model="row.content" :disabled="!planEditable" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="本月计划完成的事项…" />
              </template>
            </el-table-column>
            <el-table-column label="分值" width="120">
              <template #default="{ row }">
                <el-input-number v-model="row.score" :disabled="!planEditable" :min="0" :max="100" :step="5" controls-position="right" size="small" />
              </template>
            </el-table-column>
            <el-table-column v-if="showSelfCols" label="自评分" width="96">
              <template #default="{ row }">
                <span class="muted">{{ row.selfScore ?? '—' }} / {{ row.score }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="reviewStatus === 'LEADER_DONE'" label="复核分" width="92">
              <template #default="{ row }">
                <span class="pbc-leader-score">{{ row.leaderScore ?? '—' }} / {{ row.score }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="planEditable" label="操作" width="70">
              <template #default="{ $index }">
                <el-button text type="danger" size="small" @click="removePbcItem($index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="pbc-foot">
            <el-button v-if="planEditable" text type="primary" @click="addPbcItem"><el-icon><Plus /></el-icon>&nbsp;添加事项</el-button>
            <el-button text @click="openMyPbc">预览</el-button>
            <span class="muted">当前合计：</span>
            <el-tag :type="pbcTotal === 100 ? 'success' : 'danger'" effect="plain">{{ pbcTotal }} / 100</el-tag>
            <el-button v-if="planEditable" type="primary" :loading="pbcSaving" :disabled="pbcTotal !== 100" @click="savePbc">保存 PBC</el-button>
            <el-button v-if="canSelfReview" text type="warning" @click="pbcView = 'self'">去填写自评 →</el-button>
          </div>
          <PbcResultCard
            v-if="showSelfCols"
            :month="pbcMonth"
            :review-status="reviewStatus"
            :self-total="selfTotalNow"
            :leader-total="leaderTotalNow"
            :self-summary="selfSummary || null"
            :leader-comment="pbcLeaderComment"
            :self-at="selfAt"
            :leader-at="leaderAt"
            :pbc-leader-name="pbcLeaderName"
            :last-revoke="lastRevoke"
            :items="pbcItems"
          />
        </template>

        <!-- 我的自评：逐条自评分 + 整月总述 + 选定打分上级（不限时间，历史月可补录） -->
        <template v-else>
          <el-alert
            v-if="reviewStatus === 'LEADER_DONE'"
            class="pbc-lock-alert"
            type="success"
            :closable="false"
            show-icon
            :title="`该月已由${pbcLeaderName ? `「${pbcLeaderName}」` : '上级'}复核定稿，最终得分 ${leaderTotalNow} 分`"
            description="定稿后自评不可再改；如需更正请联系管理员撤销定稿。"
          />
          <el-alert
            v-else
            class="pbc-guide"
            type="info"
            :closable="false"
            show-icon
            title="自评不限时间"
            :description="`原定自评期为 ${selfReviewWindow || '月末 3 天 ~ 次月 5 号'}，已过仍可补录或修改；提交后由打分上级复核，最终得分以复核结果为准。`"
          />
          <el-alert
            v-if="!canSelfReview && reviewStatus !== 'LEADER_DONE'"
            class="pbc-lock-alert"
            type="warning"
            :closable="false"
            show-icon
            title="该月还不能自评"
            description="需要该月 PBC 计划已提交并通过审批后才能自评；历史月份可随时补填计划。"
          />
          <el-table :data="pbcItems" class="pbc-table" v-loading="pbcLoading">
            <el-table-column label="事项" min-width="220">
              <template #default="{ row }"><span class="pbc-item-text">{{ row.content || '（空）' }}</span></template>
            </el-table-column>
            <el-table-column label="分值" width="70" align="center">
              <template #default="{ row }"><span class="muted">{{ row.score }}</span></template>
            </el-table-column>
            <el-table-column label="自评分" width="120">
              <template #default="{ row }">
                <el-input-number v-if="canSelfReview" v-model="row.selfScore" :min="0" :max="row.score || 0" :step="1" controls-position="right" size="small" placeholder="0" />
                <span v-else class="muted">{{ row.selfScore ?? '—' }} / {{ row.score }}</span>
              </template>
            </el-table-column>
            <el-table-column label="自评理由" min-width="200">
              <template #default="{ row }">
                <el-input v-if="canSelfReview" v-model="row.selfReason" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="完成情况与理由…" />
                <span v-else class="pbc-reason">{{ row.selfReason || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="reviewStatus === 'LEADER_DONE'" label="复核分" width="92" align="center">
              <template #default="{ row }">
                <span class="pbc-leader-score">{{ row.leaderScore ?? '—' }} / {{ row.score }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="reviewStatus === 'LEADER_DONE'" label="复核评语" min-width="160">
              <template #default="{ row }"><span class="pbc-reason">{{ row.leaderComment || '—' }}</span></template>
            </el-table-column>
          </el-table>
          <div class="pbc-selfreview">
            <div class="pbc-selfreview-head">
              <span class="sec-label">整月自评总述</span>
              <el-tag type="warning" effect="plain" size="small">自评合计：{{ selfTotalNow }}</el-tag>
            </div>
            <el-input
              v-model="selfSummary"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              :disabled="!canSelfReview"
              placeholder="本月整体完成情况与亮点（自评总述，可选）…"
            />
            <div class="pbc-selfreview-foot">
              <span class="muted">打分上级：</span>
              <el-select v-model="selectedLeaderId" placeholder="默认直属上级/部门负责人" clearable size="small" class="pbc-leader-sel" :disabled="!canSelfReview">
                <el-option v-for="o in leaderOptions" :key="o.id" :label="`${o.name}（${o.label}）`" :value="o.id" />
              </el-select>
              <el-button v-if="canSelfReview" type="primary" :loading="selfSaving" @click="submitSelfReview">
                {{ reviewStatus === 'SELF_DONE' ? '更新自评' : '提交自评' }}
              </el-button>
              <el-button v-if="canSelfReview && pbcStatus !== 'DRAFT'" text @click="openMyPbc">预览</el-button>
            </div>
            <div v-if="canSelfReview" class="muted tip">自评分逐条填写于上表「自评分」列，每条不高于该行分值；提交后由打分上级复核并定稿。</div>
          </div>
          <PbcResultCard
            v-if="showSelfCols"
            :month="pbcMonth"
            :review-status="reviewStatus"
            :self-total="selfTotalNow"
            :leader-total="leaderTotalNow"
            :self-summary="selfSummary || null"
            :leader-comment="pbcLeaderComment"
            :self-at="selfAt"
            :leader-at="leaderAt"
            :pbc-leader-name="pbcLeaderName"
            :last-revoke="lastRevoke"
            :items="pbcItems"
          />
        </template>
      </template>

      <!-- 周报：手写（三段式）与 AI 生成两个入口 -->
      <template v-else-if="viewerMode === 'me'">
        <div class="weekly-entries">
          <el-button type="primary" @click="openWeeklyWrite">
            <el-icon><EditPen /></el-icon>&nbsp;手写周报（三段式）
          </el-button>
          <el-button :type="aiGenVisible ? 'success' : 'default'" plain @click="aiGenVisible = !aiGenVisible">
            <el-icon v-if="!aiGenVisible"><MagicStick /></el-icon>
            {{ aiGenVisible ? '收起 AI 生成' : 'AI 生成周报' }}
          </el-button>
        </div>

        <!-- AI 生成（原能力保留） -->
        <template v-if="aiGenVisible">
          <div class="form-row">
            <el-date-picker
              v-model="periodStart"
              type="week"
              value-format="YYYY-MM-DD"
              placeholder="选择周"
              class="date-sel"
            />
            <el-radio-group v-model="scope">
              <el-radio-button value="me">我的</el-radio-button>
              <el-radio-button value="team">团队</el-radio-button>
            </el-radio-group>
          </div>

          <el-input
            v-model="manualContent"
            type="textarea"
            :rows="3"
            class="manual"
            placeholder="手动补充内容（可选）：本周做了什么、遇到什么问题…"
          />

          <el-button type="primary" :loading="generating" @click="generate" class="gen-btn">
            <el-icon v-if="!generating"><MagicStick /></el-icon>
            {{ generating ? 'AI 生成中…' : 'AI 生成周报' }}
          </el-button>
          <div class="muted tip">AI 会根据任务活动、钉钉群消息和你的补充内容自动生成</div>
        </template>
      </template>

      <!-- 团队成员视角：日报/周报看下方历史记录（可按成员筛选），PBC 看下方成员月度计划表 -->
      <template v-else>
        <div class="muted tip team-hint">
          {{ type === 'PBC' ? '团队成员月度 PBC 概览见下方表格（展开行可查看事项明细）。' : '在下方历史记录中按「成员」筛选，即可查看该成员提交的日报/周报。' }}
        </div>
      </template>

      <!-- 手写周报弹窗（三段式） -->
      <el-dialog v-model="weeklyWriteVisible" title="手写周报（三段式，提交即发布）" width="min(94vw, 560px)">
        <!-- 由本周已交日报一键生成草稿：回填后可人工修改，再提交 -->
        <div class="sec-item weekly-ai">
          <el-button size="small" type="primary" plain :loading="drafting" @click="genWeeklyDraft">
            <el-icon v-if="!drafting"><MagicStick /></el-icon>&nbsp;{{ drafting ? 'AI 生成中…' : 'AI 生成' }}
          </el-button>
          <span class="muted weekly-ai-tip">由本周已交日报自动生成草稿，可修改后再提交</span>
        </div>
        <div class="sec-item">
          <div class="sec-label">【已完成的工作】</div>
          <el-input v-model="weeklyDone" type="textarea" :rows="4" placeholder="本周完成了什么…" />
        </div>
        <div class="sec-item">
          <div class="sec-label">【后续计划】<span class="muted sec-optional">（可选）</span></div>
          <el-input v-model="weeklyPlan" type="textarea" :rows="2" placeholder="下周的计划…" />
        </div>
        <div class="sec-item">
          <div class="sec-label">【需要协调的问题】<span class="muted sec-optional">（可选）</span></div>
          <el-input v-model="weeklyIssue" type="textarea" :rows="2" placeholder="需要协调的问题…" />
        </div>
        <!-- 周次：默认本周，可前后切换或选日期补发往期 -->
        <div class="sec-item weekly-period">
          <div class="sec-label">周次</div>
          <div class="weekly-period-bar">
            <el-button-group size="small">
              <el-button :type="!weeklyPeriodDate ? 'primary' : ''" @click="pickWeeklyThisWeek">本周</el-button>
              <el-button @click="shiftWeeklyWeek(-7)">上一周</el-button>
              <el-button @click="shiftWeeklyWeek(7)">下一周</el-button>
            </el-button-group>
            <el-date-picker
              v-model="weeklyPeriodDate"
              type="date"
              size="small"
              value-format="YYYY-MM-DD"
              placeholder="补发往期"
              style="width: 150px; margin-left: 8px"
            />
          </div>
          <div class="muted weekly-week-tip">{{ weeklyPeriodHint }}</div>
        </div>
        <!-- 需求 6：提交周报时勾选同步发送到关联钉钉群（原文直发，系统自动发送） -->
        <div class="sec-item weekly-group">
          <el-checkbox v-model="weeklySendGroup" @change="onWeeklySendGroupChange">提交后同步发送到关联群</el-checkbox>
          <div v-if="weeklySendGroup" v-loading="weeklyGroupsLoading" class="weekly-group-pick">
            <el-select
              v-model="weeklyGroupIds"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              size="small"
              placeholder="选择发送到的钉钉群（可多选）"
              style="width: 100%"
            >
              <el-option v-for="g in weeklyGroups" :key="g.conversationId" :label="g.groupName" :value="g.conversationId">
                <span>{{ g.groupName }}</span>
                <span class="muted weekly-g-proj">{{ g.projectNames?.length ? g.projectNames.join('、') : '周期位群' }}</span>
              </el-option>
            </el-select>
            <div v-if="weeklyGroups.length" class="muted weekly-g-tip">按周报原文直发到选中的群（带姓名·部门抬头）；同周重复提交会按最新全文再发一次</div>
            <div v-else class="muted weekly-g-tip">没有可选的关联群：你所在的项目还未在「项目设置」里绑定钉钉群</div>
          </div>
        </div>
        <template #footer>
          <el-button @click="weeklyWriteVisible = false">取消</el-button>
          <el-button type="primary" :loading="submittingWeekly" @click="submitWeeklyWrite">提交周报</el-button>
        </template>
      </el-dialog>
    </div>

    <!-- 周报生成结果预览（工作时间安排卡片已移到右栏） -->
    <div v-if="result && type === 'WEEKLY'" class="page-card">
      <div class="page-title">
        周报预览
        <el-button type="success" size="small" @click="publish(result)">确认发布</el-button>
      </div>
      <div class="result">
        <div class="summary">{{ result.content?.summary || result.summary }}</div>
        <div v-for="s in result.content?.sections || []" :key="s.title" class="section">
          <div class="section-title">{{ s.title }}</div>
          <div v-for="(item, i) in s.items" :key="i" class="section-item">· {{ item }}</div>
        </div>
        <div v-if="result.aiGenerated" class="muted ai-note">由 AI 生成，可在详情中编辑后发布</div>
      </div>
    </div>

    <!-- 历史列表（PBC 月计划不展示报告历史） -->
    <div v-if="type !== 'PBC'" class="page-card">
      <div class="page-title">
        历史记录（{{ displayReports.length }}）
      </div>
      <!-- 团队视角筛选条：独立一行，避免挤占标题；窄屏下自动换行铺满 -->
      <div v-if="canViewTeam && viewerMode === 'team'" class="team-filter-row">
        <el-select v-model="ownerFilter" size="small" class="member-filter" placeholder="全部成员">
          <el-option label="全部成员" value="all" />
          <el-option v-for="m in reportMemberOptions" :key="m.id" :label="m.name" :value="m.id" />
        </el-select>
        <el-select v-model="reportDeptFilter" size="small" class="member-filter" placeholder="全部部门">
          <el-option label="全部部门" value="all" />
          <el-option v-for="d in reportDeptOptions" :key="d" :label="d" :value="d" />
        </el-select>
        <el-select v-model="reportStatusFilter" size="small" class="member-filter" placeholder="全部状态">
          <el-option label="全部状态" value="all" />
          <el-option label="草稿" value="DRAFT" />
          <el-option label="已发布" value="PUBLISHED" />
        </el-select>
      </div>
      <!-- 文档式时间轴：与「日报看板」、「项目详情·项目日报」用同一个 ReportDoc 组件，全站日报展示形态一致 -->
      <ReportDoc :days="historyDocDays" :empty-text="historyEmpty" @open="(e: any) => openDetail(e.raw)">
        <template #actions="{ entry }">
          <el-button class="rp-open" text type="primary" size="small" @click.stop="openDetail(entry.raw)">查看</el-button>
        </template>
        <template #footer>
          <el-button v-if="historyRest > 0" text type="primary" class="rp-more" @click="showMoreHistory">
            展开更早的记录（还有 {{ historyRest }} 篇）
          </el-button>
        </template>
      </ReportDoc>
    </div>

    <!-- 团队成员 PBC 概览（仅管理员/部门负责人、团队视角）：按月列出成员及其月度计划，展开行看事项明细 -->
    <div v-if="type === 'PBC' && viewerMode === 'team'" class="page-card">
      <div class="team-filter-row">
        <el-date-picker
          v-model="pbcMonth"
          type="month"
          value-format="YYYY-MM"
          :clearable="false"
          class="pbc-month-mini"
          @change="loadPbcTeam"
        />
        <el-select v-model="pbcDeptFilter" size="small" class="member-filter" placeholder="全部部门">
          <el-option label="全部部门" value="all" />
          <el-option v-for="d in pbcDeptOptions" :key="d" :label="d" :value="d" />
        </el-select>
        <el-select v-model="pbcStatusFilter" size="small" class="member-filter" placeholder="全部状态">
          <el-option label="全部状态" value="all" />
          <el-option label="未填写" value="DRAFT" />
          <el-option label="待审批" value="SUBMITTED" />
          <el-option label="已退回" value="REJECTED" />
          <el-option label="已通过" value="APPROVED" />
        </el-select>
        <el-select v-model="pbcReviewFilter" size="small" class="member-filter" placeholder="全部考核状态">
          <el-option label="全部考核状态" value="all" />
          <el-option label="未自评" value="NOT_STARTED" />
          <el-option label="待我审核" value="SELF_DONE" />
          <el-option label="已定稿" value="LEADER_DONE" />
        </el-select>
        <el-button text type="primary" size="small" :loading="pbcTeamLoading" @click="loadPbcTeam">刷新</el-button>
        <el-button v-if="showReviewTab" text type="warning" size="small" @click="goReview">
          待我审核{{ reviewPending ? `（${reviewPending}）` : '' }}
        </el-button>
      </div>
      <div class="pbc-team-kpi">
        <el-tag size="small" type="warning" effect="plain">待审核 {{ pbcTeamKpi.pending }}</el-tag>
        <el-tag size="small" type="info" effect="plain">未自评 {{ pbcTeamKpi.notStarted }}</el-tag>
        <el-tag size="small" type="success" effect="plain">已定稿 {{ pbcTeamKpi.done }}</el-tag>
        <span class="muted">「审核」可直接逐条复核并改分，定稿后即为该成员当月最终得分</span>
      </div>
      <el-table :data="pbcTeamFiltered" v-loading="pbcTeamLoading" class="pbc-table pbc-team-table" size="small" @row-click="openTeamPbc">
        <el-table-column label="成员" prop="name" width="120" sortable />
        <el-table-column label="部门" min-width="130" :sort-by="(r: any) => r.department || '未归属'" sortable>
          <template #default="{ row }">{{ row.department || '未归属' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="96" :sort-method="sortPbcStatus" sortable>
          <template #default="{ row }">
            <el-tag :type="PBC_STATUS_TYPE[row.status] || 'info'" size="small" effect="plain">{{ PBC_STATUS_LABEL[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="考核状态" width="132" :sort-by="(r: any) => REVIEW_ORDER[r.reviewStatus] ?? 0" sortable>
          <template #default="{ row }">
            <el-tag v-if="row.hasPbc" :type="REVIEW_STATUS_TYPE[row.reviewStatus] || 'info'" size="small" effect="plain">
              {{ REVIEW_STATUS_LABEL[row.reviewStatus] || row.reviewStatus }}
            </el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="自评 / 最终" width="120" align="center">
          <template #default="{ row }">
            <span v-if="row.reviewStatus === 'SELF_DONE'" class="pbc-self-score">自评 {{ row.selfTotal ?? 0 }}</span>
            <span v-else-if="row.reviewStatus === 'LEADER_DONE'" class="pbc-leader-score">
              {{ row.leaderTotal ?? 0 }} <span class="muted">(自{{ row.selfTotal ?? 0 }})</span>
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="分解" width="88" :sort-by="(r: any) => (r.decomposed ? 1 : 0)" sortable>
          <template #default="{ row }">
            <el-tag v-if="row.hasPbc" :type="row.decomposed ? 'success' : 'info'" size="small" effect="plain">{{ row.decomposed ? '已分解' : '未分解' }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="合计分" width="88">
          <template #default="{ row }">
            <el-tag v-if="row.hasPbc" :type="row.total === 100 ? 'success' : 'warning'" size="small">{{ row.total }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="事项数" width="76" prop="itemCount" sortable />
        <el-table-column label="更新时间" width="140" prop="updatedAt" sortable>
          <template #default="{ row }">
            <span class="muted">{{ row.updatedAt ? fmt(row.updatedAt, 'MM-DD HH:mm') : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click.stop="openTeamPbc(row)">查看</el-button>
            <el-button v-if="row.canLeaderReview" size="small" text type="warning" @click.stop="openTeamPbc(row)">审核</el-button>
            <el-button v-if="row.canApprove && !row.hasPbc" size="small" text type="warning" @click.stop="remindTeam(row)">催一下</el-button>
            <el-button v-if="row.canApprove && row.status === 'SUBMITTED'" size="small" text type="success" @click.stop="approveTeam(row)">审批通过</el-button>
            <el-button v-if="row.canApprove && row.status === 'APPROVED'" size="small" text type="warning" @click.stop="revokeTeam(row)">允许修改</el-button>
            <el-button
              v-if="auth.isAdmin && row.reviewStatus === 'LEADER_DONE'"
              size="small"
              text
              type="danger"
              @click.stop="revokeReviewTeam(row)"
            >撤销定稿</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!pbcTeam.length && !pbcTeamLoading" class="muted empty">暂无可查看的团队成员</div>
    </div>
    </div><!-- /日报 · 周报 · PBC 主区 -->

    <!-- 详情弹窗 -->
    <el-dialog width="min(94vw, 640px)" v-model="detailVisible">
      <template #header>
        <div class="detail-head-row">
          <span>{{ fmt(current?.periodStart, 'YYYY-MM-DD') + ' ' + (current?.type === 'DAILY' ? '日报' : '周报') }}</span>
          <el-tag
            v-if="reportSource(current)?.label === '含群聊记录'"
            size="small"
            type="info"
            effect="plain"
          >
            含钉钉群自动记录
          </el-tag>
        </div>
      </template>
      <template v-if="current">
        <!-- 手写原文：可修订；日报保存后重新 AI 处理并更新项目进展，周报直接保存（他人报告只读） -->
        <template v-if="current.rawContent">
          <div class="edit-title">
            {{ current.type === 'DAILY' ? '日报原文（修改文字错误后保存，将重新 AI 处理并更新项目进展）' : '周报原文（直接修改保存）' }}
          </div>
          <el-input v-model="current.rawContent" type="textarea" :rows="6" :disabled="!canEditReport(current)" />
          <div v-if="current.correctedContent" class="corrected">
            <div class="edit-title">{{ current.type === 'DAILY' ? 'AI 修正后' : '发布内容' }}</div>
            <div class="corrected-text">{{ current.correctedContent }}</div>
          </div>
          <div class="muted proj-line">
            所属项目：
            <el-tag v-if="current.project" size="small" type="success" effect="plain">
              {{ current.project.name }}
            </el-tag>
            <span v-else>无法判断（未更新项目进展）</span>
          </div>
          <!-- 当日工时：提交时必填，日志详情里可改（只改工时不重跑 AI；0 = 当天没投入） -->
          <div v-if="current.type === 'DAILY'" class="form-row hours-row">
            <span class="sec-label">当日工时</span>
            <el-input-number
              v-model="current.hours"
              :min="0"
              :max="24"
              :step="0.5"
              :precision="1"
              size="small"
              :disabled="!canEditReport(current)"
              placeholder="必填"
            />
            <span class="muted tip">小时；参与每周工时排名发群（0 表示当天没投入）</span>
          </div>
        </template>
        <!-- AI 聚合生成日报：结构化预览 + 手动补充 -->
        <template v-else>
          <div class="result">
            <div class="summary">{{ current.content?.summary || current.summary }}</div>
            <div v-for="s in current.content?.sections || []" :key="s.title" class="section">
              <div class="section-title">{{ s.title }}</div>
              <div v-for="(item, i) in s.items" :key="i" class="section-item">· {{ item }}</div>
            </div>
            <div v-if="current.aiGenerated" class="muted ai-note">由 AI 生成，可在详情中编辑后发布</div>
          </div>

          <el-divider />
          <div class="edit-title">补充/修改内容</div>
          <el-input v-model="current.manualContent" type="textarea" :rows="4" placeholder="手动补充内容" :disabled="!canEditReport(current)" />
        </template>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <template v-if="canEditReport(current)">
          <template v-if="current?.rawContent">
            <el-button type="primary" :loading="saving" @click="saveRaw">
              {{ current?.type === 'DAILY' ? '保存并重新处理' : '保存' }}
            </el-button>
          </template>
          <template v-else>
            <el-button v-if="current?.status !== 'PUBLISHED'" type="success" :loading="saving" @click="publish(current)">
              确认发布
            </el-button>
            <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
          </template>
        </template>
      </template>
    </el-dialog>

    <!-- PBC 查看/审批弹窗（查看自己或他人 PBC 均采用弹窗） -->
    <PbcViewerDialog
      v-model="pbcDlgVisible"
      :row="pbcDlgRow"
      :month="pbcMonth"
      :busy="pbcTeamBusy"
      @approve="approveTeam"
      @revoke="revokeTeam"
      @reject="rejectTeam"
      @decomposed="afterTeamDecision($event.userId)"
      @reviewed="onDialogReviewed"
      @revoke-review="revokeReviewTeam"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import { projectsApi, reportsApi, meetingsApi, pbcApi, type PbcRow, type PbcStatus } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';
import PbcViewerDialog from '../components/PbcViewerDialog.vue';
import PbcRanking from '../components/PbcRanking.vue';
import PbcReviewPanel from '../components/PbcReviewPanel.vue';
import PbcResultCard from '../components/PbcResultCard.vue';
import ReportsStatsPanel from '../components/ReportsStatsPanel.vue';
import WorkSchedulePanel from '../components/WorkSchedulePanel.vue';
import PendingReviewPanel from '../components/PendingReviewPanel.vue';
import ReportDoc from '../components/ReportDoc.vue';
import type { DocDay, DocTag } from '../components/report-doc';

const auth = useAuthStore();
const myProjects = ref<any[]>([]);
const route = useRoute();

// ---- 大 tab（日报 / 周报 / PBC / 日报看板 / 工时统计）----
// 前三个 tab 直接驱动下面的 type（写卡内部仍按 DAILY/WEEKLY/PBC 分支渲染）；board/hours 内嵌日报看板与工时统计面板
type TabKey = 'daily' | 'weekly' | 'pbc' | 'board' | 'hours' | 'schedule' | 'review';
const TAB_KEYS: TabKey[] = ['daily', 'weekly', 'pbc', 'board', 'hours', 'schedule', 'review'];
const TAB_TYPE: Record<string, 'DAILY' | 'WEEKLY' | 'PBC' | undefined> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  pbc: 'PBC',
};

/** 旧链接兼容：/reports/stats 重定向过来时 tab=board（旧值 day）也归到日报看板 */
function normTab(v: any): TabKey {
  const s = String(v ?? '');
  if (s === 'day') return 'board';
  return (TAB_KEYS as string[]).includes(s) ? (s as TabKey) : 'daily';
}

const tab = ref<TabKey>(normTab(route.query.tab));

const type = ref<'DAILY' | 'WEEKLY' | 'PBC'>(TAB_TYPE[tab.value] ?? 'DAILY');

/** 点 tab：同步 type 与地址栏；报表类 tab 之间切换时重置表单并刷新列表 */
function onTabChange(name: any) {
  tab.value = normTab(name);
  const q = { ...route.query };
  if (tab.value === 'daily') delete q.tab;
  else q.tab = tab.value;
  router.replace({ query: q });
  const next = TAB_TYPE[tab.value];
  if (next && next !== type.value) {
    type.value = next;
    onTypeChange();
  }
}

/** 外部跳过来（/reports/stats → /reports?tab=board 等深链）时回读 tab */
watch(
  () => route.query.tab,
  (v) => {
    const next = normTab(v);
    if (next === tab.value) return;
    tab.value = next;
    const t = TAB_TYPE[next];
    if (t && t !== type.value) {
      type.value = t;
      onTypeChange();
    }
  },
);

// ---- 我的工作时间安排已迁出为独立 TAB（components/WorkSchedulePanel.vue，首页复用同一组件）----
const periodStart = ref('');
const scope = ref<'me' | 'team'>('me');
const manualContent = ref('');
const generating = ref(false);
const saving = ref(false);

// ---- 日报（三段式手写提交，AI 整理并更新项目进展） ----
const dailyDone = ref('');
const dailyPlan = ref('');
const dailyIssue = ref('');
/** 当日工时（人工填写，空=交给 AI 从正文识别） */
const dailyHours = ref<number | null>(null);
const submittingDaily = ref(false);
const lastResult = ref<any>(null);

// ---- 周报（手写三段式 / AI 生成 两个入口） ----
const weeklyWriteVisible = ref(false);
const submittingWeekly = ref(false);
const aiGenVisible = ref(false);
const weeklyDone = ref('');
const weeklyPlan = ref('');
const weeklyIssue = ref('');

// ---- 周报周次（归属已改为个人自动汇集，填报不再手选） ----
const weeklyPeriodDate = ref(''); // '' = 本周（不传 periodStart）；否则为所选周内任一天 YYYY-MM-DD
const weeklyComposeWeekLabel = ref(''); // 服务端返回的本周标号（{M}月第{N}周 · ISO）
const weeklyPeriodHint = computed(() => {
  if (!weeklyPeriodDate.value) return `本周${weeklyComposeWeekLabel.value ? `（${weeklyComposeWeekLabel.value}）` : ''}`;
  return `补发到 ${weeklyPeriodDate.value} 所在周`;
});

function pickWeeklyThisWeek() {
  weeklyPeriodDate.value = '';
}

const router = useRouter();
function goCompanyWeekly() {
  router.push('/reports/weekly-aggregate');
}
function shiftWeeklyWeek(deltaDays: number) {
  const cur = weeklyPeriodDate.value ? dayjs(weeklyPeriodDate.value) : dayjs();
  const next = cur.add(deltaDays, 'day');
  // 不补发到未来（本周之后无意义）；本周表示为 ''
  if (next.startOf('week').isAfter(dayjs().startOf('week'))) {
    weeklyPeriodDate.value = '';
  } else {
    weeklyPeriodDate.value = next.format('YYYY-MM-DD');
  }
}

/** 加载本周周次标注（归属已去掉，不再取可归属项目/部门列表） */
async function loadWeeklyComposeOptions() {
  try {
    const r = await reportsApi.weeklyComposeOptions();
    weeklyComposeWeekLabel.value = r?.weekLabel && r?.isoWeek ? `${r.weekLabel} · ${r.isoWeek}` : r?.weekLabel ?? '';
  } catch {
    weeklyComposeWeekLabel.value = '';
  }
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
  confirmedText = dailyDone.value; // 以当前输入为起点继续追加
  interimBuffer = '';
  recognition.onresult = (e: any) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) confirmedText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    interimBuffer = interim;
    dailyDone.value = confirmedText + interim;
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
      dailyDone.value = confirmedText;
    }
  };
  recognition.start();
  listening.value = true;
}

function stopVoice() {
  if (listening.value) recognition?.stop();
}

/** 三段内容拼接为固定分节文本（空段省略标题，与手写周报同一协议） */
function buildSectionedText(done: string, plan: string, issue: string) {
  const parts: string[] = [];
  if (done.trim()) parts.push(`【已完成的工作】\n${done.trim()}`);
  if (plan.trim()) parts.push(`【后续计划】\n${plan.trim()}`);
  if (issue.trim()) parts.push(`【需要协调的问题】\n${issue.trim()}`);
  return parts.join('\n\n');
}

/** 提交手写日报：直接提交，AI 整理并智能更新到项目进展（工时必填，漏填前端先拦） */
async function submitDaily() {
  const text = buildSectionedText(dailyDone.value, dailyPlan.value, dailyIssue.value);
  if (!text) {
    ElMessage.warning('请先填写或说出日报内容');
    return;
  }
  if (dailyHours.value === null || dailyHours.value === undefined) {
    ElMessage.warning('请先填写当日工时（小时）；确实没投入也请填 0');
    return;
  }
  submittingDaily.value = true;
  try {
    const res: any = await reportsApi.submitDaily(text, dailyHours.value);
    lastResult.value = res;
    const bk: any[] = res?.backfill || [];
    const bkMsg = bk.length
      ? '，已补录' + bk.map((b) => b.label + (b.type === 'DAILY' ? '日报' : '周报')).join('、')
      : '';
    ElMessage.success('日报已提交，AI 已整理并更新项目进展' + bkMsg);
    dailyDone.value = '';
    dailyPlan.value = '';
    dailyIssue.value = '';
    dailyHours.value = null;
    loadList();
  } finally {
    submittingDaily.value = false;
  }
}

/** 打开手写周报弹窗（清空上次草稿） */
function openWeeklyWrite() {
  weeklyDone.value = '';
  weeklyPlan.value = '';
  weeklyIssue.value = '';
  weeklySendGroup.value = false;
  weeklyGroupIds.value = [];
  weeklyPeriodDate.value = '';
  loadWeeklyComposeOptions();
  loadWeeklyGroups();
  weeklyWriteVisible.value = true;
}

// ---- 周报草稿：按弹窗当前「周次」把已交日报聚合成三段回填，人工可改再提交 ----
const drafting = ref(false);

async function genWeeklyDraft() {
  drafting.value = true;
  try {
    const extra: { periodStart?: string } = {};
    if (weeklyPeriodDate.value) extra.periodStart = weeklyPeriodDate.value;
    const r: any = await reportsApi.weeklyDraft(extra);
    if (r.done) weeklyDone.value = r.done;
    if (r.plan) weeklyPlan.value = r.plan;
    if (r.issue) weeklyIssue.value = r.issue;
    if (r.ok) ElMessage.success(`已由本周 ${r.dailyCount} 篇日报生成草稿，请核对修改后提交`);
    else ElMessage.warning(r.reason || 'AI 暂不可用，已填入日报原文，请自行整理');
  } catch (e: any) {
    ElMessage.error(e?.message || '生成失败');
  } finally {
    drafting.value = false;
  }
}

// ---- 周报同步发群（需求 6）：候选群 = 我参与项目已绑定的钉钉群 + 周期位群 ----
const weeklySendGroup = ref(false);
const weeklyGroupIds = ref<string[]>([]);
const weeklyGroups = ref<{ conversationId: string; groupName: string; projectNames: string[] }[]>([]);
const weeklyGroupsLoading = ref(false);

async function loadWeeklyGroups() {
  if (weeklyGroups.value.length) return; // 同一页内候选群基本不变，拉过一次就复用
  weeklyGroupsLoading.value = true;
  try {
    weeklyGroups.value = await meetingsApi.groupOptions();
  } catch {
    weeklyGroups.value = [];
  } finally {
    weeklyGroupsLoading.value = false;
  }
}

/** 勾选时默认全选关联群（取消勾选则清空，提交时不会发任何群） */
async function onWeeklySendGroupChange(v: any) {
  if (v) {
    await loadWeeklyGroups();
    weeklyGroupIds.value = weeklyGroups.value.map((g) => g.conversationId);
  } else {
    weeklyGroupIds.value = [];
  }
}

/** 提交手写周报：本周一为周期起点，直接提交即发布，同周重复提交追加合并；勾选了群则同步原文发群 */
async function submitWeeklyWrite() {
  const text = buildSectionedText(weeklyDone.value, weeklyPlan.value, weeklyIssue.value);
  if (!text) {
    ElMessage.warning('请至少填写一个部分的内容');
    return;
  }
  const ids = weeklySendGroup.value ? weeklyGroupIds.value.filter(Boolean) : [];
  if (weeklySendGroup.value && !ids.length) {
    ElMessage.warning('已勾选同步发群，请至少选一个钉钉群');
    return;
  }
  const extra: { periodStart?: string } = {};
  if (weeklyPeriodDate.value) extra.periodStart = weeklyPeriodDate.value;
  submittingWeekly.value = true;
  try {
    const r: any = await reportsApi.submitWeekly(text, ids, extra);
    const sent = Array.isArray(r?.groups) ? r.groups : [];
    const okNames = sent.filter((g: any) => g.ok).map((g: any) => g.groupName || '群');
    const badNames = sent.filter((g: any) => !g.ok).map((g: any) => `${g.groupName || g.conversationId}（${g.error || '发送失败'}）`);
    const base = '周报已提交发布（同周再次提交将追加合并）';
    if (badNames.length) ElMessage.warning(`${base}，已发 ${okNames.length} 个群；失败：${badNames.join('、')}`);
    else if (okNames.length) ElMessage.success(`${base}，原文已同步到：${okNames.join('、')}`);
    else ElMessage.success(base);
    weeklyWriteVisible.value = false;
    weeklyDone.value = '';
    weeklyPlan.value = '';
    weeklyIssue.value = '';
    weeklySendGroup.value = false;
    weeklyGroupIds.value = [];
    loadList();
  } finally {
    submittingWeekly.value = false;
  }
}

/** 切换日报/周报/PBC：重置对应表单；PBC 加载月度计划，其余刷新报告列表 */
// PBC 会替管理员/负责人切到「团队成员」视角；记下切换前的视角，离开 PBC 时还回去，
// 否则从 PBC tab 点回日报 tab 会停在团队列表，「我的」填写表单（提交日报按钮）凭空消失
let viewerBeforePbc: 'me' | 'team' | null = null;
function onTypeChange() {
  dailyDone.value = '';
  dailyPlan.value = '';
  dailyIssue.value = '';
  weeklyWriteVisible.value = false;
  lastResult.value = null;
  defaultPeriod();
  if (type.value === 'PBC') {
    // PBC：默认停在「我的」——我的计划 / 我的自评 / 待我审核 / 排行榜 四个子视图都在这边
    if (viewerMode.value === 'team') loadPbcTeam();
    else loadPbc();
    loadReviewPending();
  } else {
    if (viewerBeforePbc) {
      viewerMode.value = viewerBeforePbc;
      viewerBeforePbc = null;
    }
    loadList();
  }
}

/** 视角切换（我的/团队成员）：PBC 重新加载对应视图；日报/周报列表已含可见范围，无需重拉 */
function onViewerChange() {
  ownerFilter.value = 'all';
  if (type.value === 'PBC') {
    if (viewerMode.value === 'team') loadPbcTeam();
    else loadPbc();
  } else {
    loadList();
  }
}

// ---- PBC（月度个人业务承诺：事项+分值，合计=100） ----
const pbcMonth = ref(dayjs().format('YYYY-MM'));
/** 深链指定月份（首页 PBC 提醒 ?tab=pbc&month=YYYY-MM）：合法才采用 */
const QUERY_MONTH_RE = /^\d{4}-\d{2}$/;
if (QUERY_MONTH_RE.test(String(route.query.month ?? ''))) pbcMonth.value = String(route.query.month);
watch(
  () => route.query.month,
  (v) => {
    const s = String(v ?? '');
    if (!QUERY_MONTH_RE.test(s) || s === pbcMonth.value) return;
    pbcMonth.value = s;
    if (tab.value === 'pbc') loadPbc();
  },
);
// 事项行：计划 content/score + 考核阶段逐条自评/上级字段（旧数据无这些字段时视为未评）
const pbcItems = ref<{ content: string; score: number; selfScore: number | null; selfReason: string | null; leaderScore: number | null; leaderComment: string | null }[]>([]);
const pbcLoading = ref(false);
const pbcSaving = ref(false);
const pbcTotal = computed(() => pbcItems.value.reduce((s, it) => s + (Number(it.score) || 0), 0));
// 审批状态（锁定后本人不可再编辑）
const pbcStatus = ref<PbcStatus>('DRAFT');
const pbcLocked = ref(false);
const pbcApprover = ref<string | null>(null);
// 退回修改意见（本人视角展示，重新提交后清空）
const pbcReviewComment = ref<string | null>(null);
const pbcReviewer = ref<string | null>(null);
const PBC_STATUS_LABEL: Record<string, string> = { DRAFT: '未填写', SUBMITTED: '待审批', APPROVED: '已通过', REJECTED: '已退回' };
const PBC_STATUS_TYPE: Record<string, string> = { DRAFT: 'info', SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger' };
// ---- 考核轴（自评→上级评分） ----
const reviewStatus = ref<'NOT_STARTED' | 'SELF_DONE' | 'LEADER_DONE'>('NOT_STARTED');
const REVIEW_STATUS_LABEL: Record<string, string> = { NOT_STARTED: '未自评', SELF_DONE: '已自评·待上级评分', LEADER_DONE: '已评分定稿' };
const REVIEW_STATUS_TYPE: Record<string, string> = { NOT_STARTED: 'info', SELF_DONE: 'warning', LEADER_DONE: 'success' };
const canSelfReview = ref(false);
const selfSummary = ref('');
const pbcLeaderComment = ref<string | null>(null);
const selfTotalNow = computed(() => pbcItems.value.reduce((s, it) => s + (Number(it.selfScore) || 0), 0));
const leaderTotalNow = computed(() => pbcItems.value.reduce((s, it) => s + (Number(it.leaderScore) || 0), 0));
const leaderOptions = ref<{ id: string; name: string; label: string }[]>([]);
const selectedLeaderId = ref<string | null>(null);
const selfSaving = ref(false);
/** 自评区表列（逐条自评分/理由）是否展示：可自评或已进考核 */
const showSelfCols = computed(() => canSelfReview.value || reviewStatus.value !== 'NOT_STARTED');
// ---- 时间窗口（固定 PBC 节奏） ----
const planWindowOpen = ref(true);
const planWindowHint = ref('');
const selfReviewWindowOpen = ref(true);
const selfReviewWindow = ref('');
/** 考核结果的补充信息（自评提交/复核定稿时间、打分上级、撤销留痕） */
const selfAt = ref<string | null>(null);
const leaderAt = ref<string | null>(null);
const pbcLeaderName = ref<string | null>(null);
const lastRevoke = ref<{ at: string; byName: string; note: string | null } | null>(null);
/** 计划可编辑：未被审批锁定 且 处于计划填写窗口（当月 1~10 号/管理员；历史月不限） */
const planEditable = computed(() => !pbcLocked.value && planWindowOpen.value);
/** 我的 PBC 视图切换：我的计划 / 我的自评 / 待我审核 / 排行榜 */
type PbcViewKey = 'plan' | 'self' | 'review' | 'rank';
function normPbcView(v: any): PbcViewKey {
  const s = String(v ?? '');
  return (['plan', 'self', 'review', 'rank'] as string[]).includes(s) ? (s as PbcViewKey) : 'plan';
}
const pbcView = ref<PbcViewKey>(normPbcView(route.query.view));
/** 「待我审核」页签：ADMIN 恒显示；其他人有待审核任务时显示 */
const reviewPending = ref(0);
const showReviewTab = computed(() => auth.isAdmin || reviewPending.value > 0);

/** 切 PBC 子视图：同步到地址栏（钉钉消息可直接深链到「待我审核」） */
function onPbcViewChange(name: any) {
  const v = normPbcView(name);
  pbcView.value = v;
  const q: Record<string, any> = { ...route.query, tab: 'pbc' };
  if (v === 'plan') delete q.view;
  else q.view = v;
  router.replace({ query: q });
  if (v === 'self' || v === 'plan') loadPbc();
  if (v === 'review') loadReviewPending();
}

/** 手动切月：清掉地址栏的深链月份（?month=），避免下次从首页提醒进来时月份被旧值顶回 */
function onPbcMonthChange() {
  if (route.query.month) {
    const q = { ...route.query };
    delete q.month;
    router.replace({ query: q });
  }
  loadPbc();
}

/** 只查待审核数量（用于页签角标与是否显示「待我审核」） */
async function loadReviewPending() {
  try {
    const q = await pbcApi.reviewQueue();
    reviewPending.value = q.pending;
  } catch {
    reviewPending.value = 0;
  }
}

/** 复核完成后：刷新待审核数量与当前月数据 */
async function onReviewDone() {
  await loadReviewPending();
  await loadPbc();
}

/** 加载当前月 PBC（无记录则空表格） */
async function loadPbc() {
  if (!pbcMonth.value) return;
  pbcLoading.value = true;
  try {
    const r = await pbcApi.get(pbcMonth.value);
    pbcItems.value = (r.items ?? []).map((it) => ({
      content: it.content,
      score: Number(it.score) || 0,
      selfScore: it.selfScore ?? null,
      selfReason: it.selfReason ?? null,
      leaderScore: it.leaderScore ?? null,
      leaderComment: it.leaderComment ?? null,
    }));
    if (!pbcItems.value.length) pbcItems.value = [{ content: '', score: 0, selfScore: null, selfReason: null, leaderScore: null, leaderComment: null }];
    pbcStatus.value = r.status ?? 'DRAFT';
    pbcLocked.value = !!r.locked;
    pbcApprover.value = r.approverName ?? null;
    pbcReviewComment.value = r.reviewComment ?? null;
    pbcReviewer.value = (r as any).reviewerName ?? null;
    // 考核轴（自评不限时间：只要有计划且未定稿就可编辑）
    reviewStatus.value = r.reviewStatus ?? 'NOT_STARTED';
    canSelfReview.value = (r as any).selfReviewEditable === undefined ? !!r.canSelfReview : !!(r as any).selfReviewEditable;
    // 时间窗口标志（缺省视为开放，兼容旧后端；自评窗口仅作参考提示）
    planWindowOpen.value = (r as any).planWindowOpen !== false;
    planWindowHint.value = (r as any).planWindowHint ?? '';
    selfReviewWindowOpen.value = (r as any).selfReviewWindowOpen !== false;
    selfReviewWindow.value = (r as any).selfReviewWindow ?? '';
    selfSummary.value = r.selfSummary ?? '';
    pbcLeaderComment.value = r.leaderComment ?? null;
    selfAt.value = r.selfAt ?? null;
    leaderAt.value = r.leaderAt ?? null;
    pbcLeaderName.value = r.pbcLeaderName ?? null;
    lastRevoke.value = (r as any).lastRevoke ?? null;
    leaderOptions.value = r.leaderOptions ?? [];
    // 选定打分上级：已有则用历史，否则默认上级（均回落 null 由后端再解）
    selectedLeaderId.value = r.pbcLeaderId ?? r.defaultLeaderId ?? null;
  } finally {
    pbcLoading.value = false;
  }
}

/** 提交自评：逐条自评分（≤该行分值）+ 整月总述 + 选定上级，提交后转 SELF_DONE 等上级评分 */
async function submitSelfReview() {
  const rows = pbcItems.value.filter((it) => it.content.trim());
  if (!rows.length) {
    ElMessage.warning('本月尚无 PBC 事项，无法自评');
    return;
  }
  for (const it of rows) {
    const v = Number(it.selfScore ?? 0);
    if (!Number.isFinite(v) || v < 0 || v > it.score) {
      ElMessage.warning(`自评分需为 0～该行分值（${it.score}）之间的数字`);
      return;
    }
  }
  selfSaving.value = true;
  try {
    const items = rows.map((it, i) => ({ index: i, selfScore: Number(it.selfScore) || 0, selfReason: (it.selfReason ?? '').trim() }));
    const r = await pbcApi.selfReview(pbcMonth.value, { items, selfSummary: selfSummary.value.trim(), pbcLeaderId: selectedLeaderId.value });
    ElMessage.success(`已提交自评（合计 ${r.selfTotal} 分），等待${r.pbcLeaderName ? `「${r.pbcLeaderName}」` : '上级'}评分`);
    await loadPbc();
  } finally {
    selfSaving.value = false;
  }
}

/** 查看自己本月 PBC（弹窗）：用当前编辑态拼一个 row 供通用弹窗展示 */
function openMyPbc() {
  const items = pbcItems.value.filter((it) => it.content.trim());
  pbcDlgRow.value = {
    userId: auth.user?.id ?? '',
    name: auth.user?.name ?? '我',
    department: null,
    hasPbc: items.length > 0,
    total: pbcTotal.value,
    itemCount: items.length,
    items,
    status: pbcStatus.value,
    approverName: pbcApprover.value,
    approvedAt: null,
    reviewComment: pbcReviewComment.value,
    canApprove: false,
    isSelf: true,
    updatedAt: null,
    decomposedAt: null,
    decomposed: false,
    reviewStatus: reviewStatus.value,
    selfTotal: selfTotalNow.value,
    leaderTotal: leaderTotalNow.value,
    selfSummary: selfSummary.value || null,
    leaderComment: pbcLeaderComment.value,
    pbcLeaderId: selectedLeaderId.value,
    pbcLeaderName: null,
    canSelfReview: false,
    canLeaderReview: false,
  } as PbcRow;
  pbcDlgVisible.value = true;
}

function addPbcItem() {
  pbcItems.value.push({ content: '', score: 0, selfScore: null, selfReason: null, leaderScore: null, leaderComment: null });
}

function removePbcItem(index: number) {
  pbcItems.value.splice(index, 1);
}

/** 保存 PBC：仅提交有内容的行，后端校验合计=100 */
async function savePbc() {
  if (pbcTotal.value !== 100) {
    ElMessage.warning('所有事项分值合计须等于 100');
    return;
  }
  pbcSaving.value = true;
  try {
    const r = await pbcApi.save(
      pbcMonth.value,
      pbcItems.value.filter((it) => it.content.trim()),
    );
    ElMessage.success('PBC 已保存（已提交待审批）');
    pbcItems.value = (r.items ?? []).map((it) => ({ content: it.content, score: Number(it.score) || 0, selfScore: null, selfReason: null, leaderScore: null, leaderComment: null }));
    if (!pbcItems.value.length) pbcItems.value = [{ content: '', score: 0, selfScore: null, selfReason: null, leaderScore: null, leaderComment: null }];
    pbcStatus.value = r.status ?? 'SUBMITTED';
    pbcLocked.value = !!r.locked;
    // 重新提交后退回意见已处理，清空；计划重提后回到未自评
    pbcReviewComment.value = null;
    pbcReviewer.value = null;
    reviewStatus.value = 'NOT_STARTED';
  } finally {
    pbcSaving.value = false;
  }
}

const result = ref<any>(null);
const list = ref<any[]>([]);

// ---- 视角切换（我的 / 团队成员）：仅管理员与部门负责人可用 ----
const viewerMode = ref<'me' | 'team'>('me');
const ownerFilter = ref<string>('all');
const reportDeptFilter = ref<string>('all');
const reportStatusFilter = ref<string>('all');
const canViewTeam = computed(() => auth.isAdmin || auth.isDeptLeader);

/** 报告归属部门名（无归属/团队报告 → 未归属），供部门列展示与筛选 */
function reportDeptOf(r: any) {
  return r?.owner?.department?.name || '未归属';
}

/** 周报归属标签：scopeKey P:→项目名 / D:→部门 / 空→个人（日报不显示） */
function reportScope(r: any): { label: string; type: string } | null {
  if (!r || r.type !== 'WEEKLY') return null;
  const sk = String(r.scopeKey ?? '');
  if (sk.startsWith('P:')) return { label: `项目·${r.project?.name || '未知'}`, type: 'success' };
  if (sk.startsWith('D:')) return { label: '部门', type: 'warning' };
  return { label: '个人', type: 'info' };
}

/** 周报周次标注（{M}月第{N}周），由北京周一时间反推北京墙钟周一 */
function reportWeekTag(r: any): string {
  if (!r || r.type !== 'WEEKLY') return '';
  const bj = dayjs(r.periodStart).add(8, 'hour'); // periodStart 为北京周一 00:00 的绝对时刻
  const month = bj.month() + 1;
  const nth = Math.floor((bj.date() - 1) / 7) + 1;
  return `${month}月第${nth}周`;
}
/** 报告状态排序权重：草稿在前、已发布在后 */
const REPORT_ORDER: Record<string, number> = { DRAFT: 0, PUBLISHED: 1 };
function sortReportStatus(a: any, b: any) {
  return (REPORT_ORDER[a.status] ?? 9) - (REPORT_ORDER[b.status] ?? 9);
}

/** 根据视角 + 成员/部门/状态筛选过滤报告 */
const displayReports = computed(() => {
  let rows = list.value;
  if (viewerMode.value !== 'team') {
    return rows.filter((r) => r.ownerId === auth.user?.id);
  }
  if (ownerFilter.value !== 'all') rows = rows.filter((r) => r.ownerId === ownerFilter.value);
  if (reportDeptFilter.value !== 'all') rows = rows.filter((r) => reportDeptOf(r) === reportDeptFilter.value);
  if (reportStatusFilter.value !== 'all') rows = rows.filter((r) => r.status === reportStatusFilter.value);
  return rows;
});

/** 团队视角下成员下拉选项（从可见报告中去重得出） */
const reportMemberOptions = computed(() => {
  const map = new Map<string, string>();
  for (const r of list.value) {
    if (r.ownerId && !map.has(r.ownerId)) map.set(r.ownerId, r?.owner?.name || '成员');
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

/** 团队视角下部门下拉选项（从可见报告归属部门去重） */
const reportDeptOptions = computed(() => {
  const set = new Set<string>();
  for (const r of list.value) set.add(reportDeptOf(r));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
});

// ---- 历史记录：文档式日期时间轴（日报按天、周报按周分组，默认只展开最近 20 篇）----
const HISTORY_STEP = 20;
const historyLimit = ref(HISTORY_STEP);
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const historyDays = computed(() => {
  const rows = [...displayReports.value].sort((a, b) =>
    String(b.periodStart || '').localeCompare(String(a.periodStart || '')) ||
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  );
  const groups: { key: string; label: string; sub: string; items: any[] }[] = [];
  for (const r of rows.slice(0, historyLimit.value)) {
    // periodStart 为北京时间零点的绝对时刻，沿用原表格的 fmt 口径（浏览器为东八区）
    const dayKey = fmt(r.periodStart, 'YYYY-MM-DD');
    let g = groups.find((x) => x.key === dayKey);
    if (!g) {
      const isDaily = type.value === 'DAILY';
      g = {
        key: dayKey,
        label: isDaily ? dayKey : reportWeekTag(r) || dayKey,
        sub: isDaily ? WEEK_CN[dayjs(r.periodStart).day()] : `${dayKey} 起 · 周`,
        items: [] as any[],
      };
      groups.push(g);
    }
    g.items.push(r);
  }
  return groups;
});

/** 历史列表→统一「文档式时间轴」组件的入参（与日报看板、项目日报同一形态） */
const historyDocDays = computed<DocDay[]>(() =>
  historyDays.value.map((g) => ({
    key: g.key,
    label: g.label,
    sub: g.sub,
    entries: g.items.map((r: any) => ({
      key: r.id,
      name: r.owner?.name || (viewerMode.value === 'team' ? '团队' : '我'),
      tags: historyTags(r),
      meta: historyMeta(r),
      content: rowContent(r),
      raw: r,
    })),
  })),
);

/** 条目右侧小标签：工时（仅日报）→ 周报归属 / 归属项目 → 发布状态 */
function historyTags(r: any): DocTag[] {
  const tags: DocTag[] = [];
  if (type.value === 'DAILY') tags.push({ label: r.hours ? `${r.hours} 小时` : '未填工时', type: r.hours ? 'warning' : 'info' });
  const scope = reportScope(r);
  if (scope) tags.push({ label: scope.label, type: scope.type as DocTag['type'] });
  else if (r.project) tags.push({ label: r.project.name, type: 'success' });
  tags.push({ label: r.status === 'PUBLISHED' ? '已发布' : '草稿', type: r.status === 'PUBLISHED' ? 'success' : 'info' });
  return tags;
}

/** 灰色附注：团队视角多一段部门，再接来源与更新时间 */
function historyMeta(r: any): string {
  const parts: string[] = [];
  if (canViewTeam.value && viewerMode.value === 'team') parts.push(reportDeptOf(r));
  parts.push(reportSource(r).label);
  if (r.updatedAt) parts.push(fmt(r.updatedAt, 'MM-DD HH:mm'));
  return parts.filter(Boolean).join(' · ');
}

const historyEmpty = computed(() =>
  `暂无${type.value === 'DAILY' ? '日报' : '周报'}${canViewTeam.value && viewerMode.value === 'team' ? '（团队成员）' : ''}记录`,
);

/** 还没展示出来的历史记录篇数（点「展开更早的记录」逐批加载） */
const historyRest = computed(() =>
  Math.max(0, displayReports.value.length - Math.min(historyLimit.value, displayReports.value.length)),
);
function showMoreHistory() {
  historyLimit.value += HISTORY_STEP;
}
// 日报/周报切换时重新从最近 20 篇开始，避免带着上一个类型的展开量
watch(type, () => {
  historyLimit.value = HISTORY_STEP;
});

// ---- 团队成员 PBC 概览（仅管理员/部门负责人）----
const pbcTeam = ref<any[]>([]);
const pbcTeamLoading = ref(false);
const pbcDeptFilter = ref<string>('all');
const pbcStatusFilter = ref<string>('all');
/** 考核状态筛选：全部 / 未自评 / 待我审核 / 已定稿 */
const pbcReviewFilter = ref<string>('all');
// PBC 状态排序权重：未填→待审批→已退回→已通过
const PBC_ORDER: Record<string, number> = { DRAFT: 0, SUBMITTED: 1, REJECTED: 2, APPROVED: 3 };
// 考核状态排序权重：未自评→待审核→已定稿
const REVIEW_ORDER: Record<string, number> = { NOT_STARTED: 0, SELF_DONE: 1, LEADER_DONE: 2 };
function sortPbcStatus(a: any, b: any) {
  return (PBC_ORDER[a.status] ?? 9) - (PBC_ORDER[b.status] ?? 9);
}
/** 部门下拉选项（从当前团队 PBC 行去重） */
const pbcDeptOptions = computed(() => {
  const set = new Set<string>();
  for (const r of pbcTeam.value) set.add(r.department || '未归属');
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
});
/** 团队表 KPI：待审核 / 未自评 / 已定稿（不含自己） */
const pbcTeamKpi = computed(() => {
  const rows = pbcTeam.value.filter((r) => !r.isSelf && r.hasPbc);
  return {
    pending: rows.filter((r) => r.reviewStatus === 'SELF_DONE').length,
    notStarted: rows.filter((r) => r.reviewStatus === 'NOT_STARTED').length,
    done: rows.filter((r) => r.reviewStatus === 'LEADER_DONE').length,
  };
});
/** 按部门/审批状态/考核状态筛选后的团队 PBC 行（不含自己——自己到「我的」页填写） */
const pbcTeamFiltered = computed(() => {
  let rows = pbcTeam.value.filter((r) => !r.isSelf);
  if (pbcDeptFilter.value !== 'all') rows = rows.filter((r) => (r.department || '未归属') === pbcDeptFilter.value);
  if (pbcStatusFilter.value !== 'all') rows = rows.filter((r) => r.status === pbcStatusFilter.value);
  if (pbcReviewFilter.value !== 'all') {
    rows = rows.filter((r) =>
      pbcReviewFilter.value === 'SELF_DONE' ? r.reviewStatus === 'SELF_DONE' && r.canLeaderReview : r.reviewStatus === pbcReviewFilter.value,
    );
  }
  return rows;
});
/** 从团队表跳到「待我审核」工作台（切回「我的」视角 + review 子视图） */
function goReview() {
  viewerMode.value = 'me';
  pbcView.value = 'review';
  onPbcViewChange('review');
}

/** 「待我审核」聚合面板跳转：项目去详情页；PBC 计划切团队视角的计划视图；PBC 考核切复核工作台 */
function onReviewJump(payload: { kind: 'project' | 'pbc-plan' | 'pbc-review'; id?: string }) {
  if (payload.kind === 'project') {
    if (payload.id) router.push('/projects/' + payload.id);
    return;
  }
  if (payload.kind === 'pbc-plan') {
    tab.value = 'pbc';
    type.value = 'PBC';
    viewerMode.value = 'team';
    pbcView.value = 'plan';
    router.replace({ query: { tab: 'pbc' } });
    loadPbcTeam();
    return;
  }
  if (payload.kind === 'pbc-review') {
    onTabChange('pbc');
    goReview();
  }
}
// PBC 查看/审批弹窗（团队行点击弹出，满足“查看他人 PBC 用弹窗”）
const pbcDlgVisible = ref(false);
const pbcDlgRow = ref<PbcRow | null>(null);
const pbcTeamBusy = ref(false);
async function loadPbcTeam() {
  if (!pbcMonth.value) return;
  pbcTeamLoading.value = true;
  try {
    pbcTeam.value = await pbcApi.team(pbcMonth.value);
  } finally {
    pbcTeamLoading.value = false;
  }
}

function openTeamPbc(row: any) {
  pbcDlgRow.value = row as PbcRow;
  pbcDlgVisible.value = true;
}

async function afterTeamDecision(userId: string) {
  await loadPbcTeam();
  if (pbcDlgVisible.value) pbcDlgRow.value = pbcTeam.value.find((r) => r.userId === userId) ?? null;
}

async function approveTeam(row: any) {
  pbcTeamBusy.value = true;
  try {
    await pbcApi.approve(row.userId, pbcMonth.value);
    ElMessage.success('该 PBC 已审批通过并锁定');
    await afterTeamDecision(row.userId);
  } finally {
    pbcTeamBusy.value = false;
  }
}

/** 撤回审批（来弹窗 emit）：回到待审批，成员可再编辑 */
async function revokeTeam(row: any) {
  pbcTeamBusy.value = true;
  try {
    await pbcApi.revoke(row.userId, pbcMonth.value);
    ElMessage.success('已允许该成员修改');
    await afterTeamDecision(row.userId);
  } finally {
    pbcTeamBusy.value = false;
  }
}

/** 上级复核完成（来弹窗 emit）：刷新团队行 + 我的待审核计数 */
async function onDialogReviewed(row: any) {
  await afterTeamDecision(row.userId);
  await loadReviewPending();
}

/** 撤销定稿（仅 ADMIN）：定稿退回「已自评·待复核」，保留分数并留痕 */
async function revokeReviewTeam(row: any) {
  try {
    const { value } = await ElMessageBox.prompt(
      `撤销 ${row.name} ${pbcMonth.value} 的定稿，考核回到「已自评·待复核」，会通知成员与打分上级。可填写撤销原因：`,
      '撤销定稿',
      { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消', inputPlaceholder: '选填' },
    );
    pbcTeamBusy.value = true;
    await pbcApi.revokeLeaderReview(row.userId, pbcMonth.value, String(value ?? '').trim() || undefined);
    ElMessage.success('已撤销定稿');
    await afterTeamDecision(row.userId);
    await loadReviewPending();
  } catch {
    /* 取消 */
  } finally {
    pbcTeamBusy.value = false;
  }
}

/** 退回修改（来弹窗 emit）：携 {row, comment}，退回后刷新并关闭弹窗 */
async function rejectTeam(payload: { row: any; comment: string }) {
  pbcTeamBusy.value = true;
  try {
    await pbcApi.reject(payload.row.userId, pbcMonth.value, payload.comment);
    ElMessage.success('已退回并钉钉通知成员修改');
    pbcDlgVisible.value = false;
    await loadPbcTeam();
  } finally {
    pbcTeamBusy.value = false;
  }
}

/** 催一下：对未写 PBC 的成员钉钉私聊催办 */
async function remindTeam(row: any) {
  pbcTeamBusy.value = true;
  try {
    const r = await pbcApi.remind(row.userId, pbcMonth.value);
    if (r.sent) ElMessage.success(`已通过钉钉提醒 ${row.name} 尽快提交本月 PBC`);
    else ElMessage.warning(`钉钉提醒未发送成功：${r.error || '该成员可能未绑定钉钉'}`);
  } finally {
    pbcTeamBusy.value = false;
  }
}

const detailVisible = ref(false);
const current = ref<any>(null);
/** 打开详情时的工时快照：只在真的改过时才提交 hours，避免误清 AI 已提取的值 */
const originalHours = ref<number | null>(null);

function defaultPeriod() {
  periodStart.value =
    type.value === 'DAILY' ? dayjs().format('YYYY-MM-DD') : dayjs().startOf('week').format('YYYY-MM-DD');
}

async function generate() {
  if (!periodStart.value) {
    ElMessage.warning('请选择日期');
    return;
  }
  generating.value = true;
  try {
    const data = {
      type: type.value,
      periodStart: periodStart.value,
      scope: scope.value,
      ...(manualContent.value.trim() ? { manualContent: manualContent.value.trim() } : {}),
    };
    result.value = await reportsApi.generate(data);
    ElMessage.success('生成完成');
    loadList();
  } finally {
    generating.value = false;
  }
}

async function publish(r: any) {
  saving.value = true;
  try {
    await reportsApi.update(r.id, { status: 'PUBLISHED', manualContent: r.manualContent });
    ElMessage.success('已发布');
    detailVisible.value = false;
    loadList();
  } finally {
    saving.value = false;
  }
}

async function saveEdit() {
  saving.value = true;
  try {
    await reportsApi.update(current.value.id, { manualContent: current.value.manualContent });
    ElMessage.success('已保存');
    loadList();
  } finally {
    saving.value = false;
  }
}

/** 修订手写日报：保存原文后后端重新 AI 处理并更新项目进展；工时改过则一并提交（以人工值为准） */
async function saveRaw() {
  const text = (current.value.rawContent || '').trim();
  if (!text) {
    ElMessage.warning('日报内容不能为空');
    return;
  }
  const hours = current.value.hours ?? null;
  const hoursChanged = hours !== (originalHours.value ?? null);
  saving.value = true;
  try {
    await reportsApi.update(
      current.value.id,
      hoursChanged ? { rawContent: text, hours } : { rawContent: text },
    );
    ElMessage.success(
      current.value.type === 'DAILY'
        ? hoursChanged
          ? '已保存，工时已按人工修正值更新'
          : '已保存并重新处理，项目进展已更新'
        : '周报原文已保存',
    );
    detailVisible.value = false;
    loadList();
  } finally {
    saving.value = false;
  }
}

/** 表格内容列：手写日报显示 AI 修正后文本，AI 生成日报显示摘要 */
function rowContent(r: any) {
  return r.correctedContent || r.content?.summary || r.aiGenerated?.summary || '（无内容）';
}

/** 来源标记：群聊同步段（raw/corrected 带「来自钉钉群聊」标注）→ 含群聊记录；有原文 → 手写；其余 → AI 生成 */
function reportSource(r: any) {
  const text = `${r?.rawContent || ''}${r?.correctedContent || ''}`;
  if (text.includes('来自钉钉群聊')) return { label: '含群聊记录', type: 'info' };
  if (r?.rawContent) return { label: '手写', type: 'primary' };
  return { label: 'AI 生成', type: 'success' };
}

/** 编辑权限：报告本人 / 系统管理员；团队聚合报告（ownerId null）需本人担任某项目负责人或政委 */
function canEditReport(r: any) {
  if (!r || !auth.user) return false;
  if (r.ownerId === auth.user.id) return true;
  if (auth.isAdmin) return true;
  if (r.ownerId === null) {
    return myProjects.value.some(
      (p: any) =>
        p.ownerId === auth.user!.id ||
        p.members?.some((m: any) => m.userId === auth.user!.id && m.role === 'COMMISSAR'),
    );
  }
  return false;
}

async function loadList() {
  if (type.value === 'PBC') {
    list.value = [];
    return;
  }
  list.value = await reportsApi.list(type.value);
}

function openDetail(r: any) {
  current.value = r;
  originalHours.value = r?.hours ?? null;
  detailVisible.value = true;
}

onMounted(async () => {
  myProjects.value = await projectsApi.list();
  defaultPeriod();
  loadList();
  // 深链进来就是 PBC tab（type 已同步为 PBC）：补一次 PBC 加载，否则页面是空表
  if (type.value === 'PBC') {
    // ?view=review 直接进「待我审核」，必须停在「我的」视角（团队视角没有这个子视图）
    if (pbcView.value === 'review') viewerMode.value = 'me';
    if (viewerMode.value === 'team') loadPbcTeam();
    else loadPbc();
    loadReviewPending();
  }
});

/** 外部深链切换 PBC 子视图（钉钉消息 ?tab=pbc&view=review） */
watch(
  () => route.query.view,
  (v) => {
    if (tab.value !== 'pbc') return;
    const next = normPbcView(v);
    if (next === pbcView.value) return;
    pbcView.value = next;
    if (next === 'review') viewerMode.value = 'me';
  },
);
</script>

<style scoped>
.page-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.sec-item {
  margin-bottom: 10px;
}
.sec-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: #303133;
}
.sec-optional {
  font-weight: 400;
  font-size: 12px;
}
/* 周报同步发群：勾选行 + 群多选 + 说明，与三段式表单同宽 */
.weekly-group {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #dcdfe6;
}
.weekly-group-pick {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.weekly-g-proj {
  float: right;
  margin-left: 12px;
  font-size: 12px;
}
.weekly-g-tip {
  font-size: 12px;
  line-height: 1.5;
}
.weekly-entries {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
/* 周报弹窗顶部「AI 生成」行：弱化成一条辅助工具栏，不与三段式表单抢视觉 */
.weekly-ai {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -4px -4px 12px;
  padding: 8px 10px;
  background: #f5f7fa;
  border-radius: 8px;
}
.weekly-ai-tip {
  font-size: 12px;
}
/* 周报归属 + 周次区 */
.weekly-scope,
.weekly-period {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #dcdfe6;
}
.weekly-period-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.weekly-week-tip {
  margin-top: 6px;
  font-size: 12px;
}
.type-tabs {
  margin-bottom: 14px;
}
.pbc-lock-alert {
  margin-bottom: 10px;
}
.pbc-guide {
  margin-bottom: 10px;
}
.pbc-guide-list {
  margin: 4px 0 0;
  padding-left: 20px;
  line-height: 1.7;
}
.pbc-review-comment {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.date-sel {
  width: 180px;
}
.manual {
  margin-bottom: 12px;
}
.gen-btn {
  width: 100%;
}
.tip {
  margin-top: 8px;
  text-align: center;
}
.result {
  background: #fafbfc;
  border-radius: 8px;
  padding: 12px 14px;
}
.summary {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
  line-height: 1.6;
}
.section {
  margin-top: 10px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  margin-bottom: 4px;
}
.section-item {
  font-size: 13px;
  line-height: 1.8;
  color: #606266;
}
.ai-note {
  margin-top: 10px;
  text-align: right;
}
.report-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.report-row:last-child {
  border-bottom: none;
}
.report-date {
  font-weight: 600;
  font-size: 14px;
  flex-shrink: 0;
}
.report-summary {
  flex: 1;
  font-size: 13px;
  color: #606266;
}
.edit-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
}
.corrected {
  margin-top: 14px;
}
.corrected-text {
  background: #f6ffed;
  border: 1px solid #e1f3d8;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: #303133;
}
.proj-line {
  margin-top: 14px;
  font-size: 13px;
}
.hours-row {
  margin-top: 10px;
}
.hours-line-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.hours-tip {
  font-size: 12px;
  line-height: 1.5;
}
.hours-required {
  color: #f56c6c;
  margin-left: 2px;
}
.report-table {
  width: 100%;
}
.daily-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
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
.ai-result {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #e4e7ed;
}
.backfill-line {
  margin-top: 10px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.empty {
  text-align: center;
  padding: 20px 0;
}
/* 团队视角筛选条：el-select 默认 width:100%，在 flex 行内会撑满剩余空间，
   需固定宽度；日期选择器不收缩，保证 YYYY-MM 完整显示 */
.team-filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.team-filter-row :deep(.member-filter) {
  width: 140px;
  flex: 0 0 auto;
}
.team-filter-row :deep(.pbc-month-mini) {
  width: 110px;
  flex: 0 0 auto;
}
/* 手机屏：筛选项均分换行，避免固定宽度在超窄屏溢出 */
@media (max-width: 767px) {
  .team-filter-row :deep(.member-filter) {
    width: calc(50% - 5px);
    flex: 1 1 auto;
  }
  .team-filter-row :deep(.pbc-month-mini) {
    width: 104px;
  }
}
.pbc-table {
  width: 100%;
  margin-top: 6px;
}
.pbc-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}
/* 自评区：计划已提交/已批且未定稿时展示 */
.pbc-selfreview {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
}
.pbc-selfreview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.pbc-selfreview-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pbc-leader-sel {
  width: 240px;
}
.pbc-reason {
  white-space: pre-wrap;
  color: #606266;
  font-size: 13px;
}
.detail-head-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: #303133;
}
/* ---- 大 tab：只做顶部导航条，窗格内容留空，下方按 tab 分支渲染 ---- */
.rm-tabs :deep(.el-tabs__header) {
  margin: 0 0 var(--sp-3);
}
.rm-tabs :deep(.el-tabs__content) {
  display: none;
}

/* 文档式时间轴的 .rp-* 样式已上提到全局 styles.css：
   历史日报（本页）、日报看板、项目详情·项目日报 三处共用同一个 ReportDoc 组件，样式只留一份 */
</style>
