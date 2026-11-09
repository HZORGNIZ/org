<template>
  <div class="page" :class="{ embedded }">
    <div class="page-title" :class="{ 'title-embedded': embedded }">
      <span v-if="!embedded">部门</span>
      <el-select v-if="switchable.length > 1" v-model="deptId" style="width: 200px" @change="loadDetail">
        <el-option v-for="d in switchable" :key="d.id" :label="d.name" :value="d.id" />
      </el-select>
    </div>

    <div v-if="!deptList.length" class="page-card">
      <div class="muted empty">暂无部门，请管理员在「管理后台 → 部门管理」中创建部门</div>
    </div>

    <!-- 全部部门汇总（管理员/部门负责人可见，点卡片进入单个部门） -->
    <div v-else-if="showAll" class="page-card">
      <div class="page-title all-head">
        <span class="all-title">全部部门（{{ deptList.length }}）</span>
        <span class="muted">点击部门查看项目、成员、文档与文件</span>
        <el-button text type="primary" size="small" @click="showAll = false">返回当前部门</el-button>
      </div>
      <div class="dept-grid">
        <div
          v-for="d in deptList"
          :key="d.id"
          class="dept-card"
          :class="{ 'dept-card-on': d.id === deptId }"
          @click="openDept(d.id)"
        >
          <div class="dept-card-name ellipsis">{{ d.name }}</div>
          <div class="muted dept-card-leader">负责人：{{ d.leader?.name || '未设置' }}</div>
          <div v-if="d.managerNames?.length" class="muted dept-card-leader">管理：{{ d.managerNames.join('、') }}</div>
          <div class="dept-card-stats">
            <span>{{ d._count?.projectLinks ?? 0 }} 项目</span>
            <span>{{ d._count?.members ?? 0 }} 成员</span>
            <span>{{ d._count?.docs ?? 0 }} 文档</span>
            <span>{{ d._count?.files ?? 0 }} 文件</span>
          </div>
        </div>
      </div>
    </div>

    <template v-else-if="detail">
      <!-- 部门概况 -->
      <div class="page-card">
        <div class="page-title dept-head">
          <div class="dept-name">{{ detail.department.name }}</div>
          <el-button v-if="switchable.length > 1" text type="primary" size="small" @click="showAll = true">
            全部部门
          </el-button>
          <el-tag v-if="detail.canManage" size="small" type="warning" effect="plain">我可管理</el-tag>
        </div>
        <div class="dept-meta muted">
          <span>负责人：{{ detail.department.leader?.name || '未设置' }}</span>
          <span v-if="detail.department.managers?.length"
            >· 管理：<a
              v-for="(mg, i) in detail.department.managers"
              :key="mg.id"
              class="dept-mgr"
              @click="$router.push('/members/' + mg.id)"
              >{{ i ? '、' : '' }}{{ mg.name }}</a
            ></span
          >
          <span>· {{ detail.projects.length }} 个项目</span>
          <span>· {{ detail.members.length }} 名成员</span>
          <span>· {{ docCount }} 篇文档</span>
        </div>
        <div v-if="detail.department.description" class="dept-desc muted">{{ detail.department.description }}</div>
      </div>

      <el-tabs v-model="tab" class="page-card dept-tabs">
        <!-- 部门内项目：仅人工「主要关联」口径（165 改回：按成员并集会灌入跨部门挂靠负责人的不相干项目） -->
        <el-tab-pane label="项目" name="projects">
          <div v-if="!detail.projects.length" class="muted empty">该部门暂无主要关联项目（在项目详情页「编辑 → 主要关联部门」中关联后显示）</div>
          <div v-for="p in detail.projects" :key="p.id" class="proj-wrap">
            <div class="proj-row">
              <span class="proj-caret" @click.stop="toggleProj(p.id)">
                <el-icon><component :is="openProjects.has(p.id) ? 'ArrowDown' : 'ArrowRight'" /></el-icon>
              </span>
              <span class="dot" :style="{ background: p.color || '#428bff' }" @click="$router.push('/projects/' + p.id)"></span>
              <span class="proj-name ellipsis" @click="$router.push('/projects/' + p.id)">{{ p.name }}</span>
              <span class="muted" @click="$router.push('/projects/' + p.id)">负责人：{{ p.owner?.name }}</span>
              <span class="muted">{{ p.memberCount }} 名成员</span>
              <span class="muted">{{ p.taskCount }} 个任务</span>
            </div>
            <div v-if="openProjects.has(p.id)" class="proj-members">
              <div v-if="p.membersHidden" class="muted">保密项目 · 仅项目成员可见名单</div>
              <template v-else>
                <div v-for="m in p.members" :key="m.id" class="pm-chip" :class="{ 'pm-chip-out': !m.inDept }">
                  <el-avatar :size="20" :src="m.avatar || undefined">{{ m.name?.slice(0, 1) }}</el-avatar>
                  <a class="pm-name" @click="$router.push('/members/' + m.id)">{{ m.name }}</a>
                  <span v-if="m.position" class="muted">{{ m.position }}</span>
                  <el-tag v-if="m.isOwner" size="small" type="warning" effect="plain">负责</el-tag>
                </div>
                <div v-if="!p.members.length" class="muted">暂无成员</div>
                <div v-if="p.members.some((m: any) => !m.inDept)" class="muted pm-note">灰底为非本部门成员</div>
              </template>
            </div>
          </div>
        </el-tab-pane>

        <!-- 部门成员（管理员/部门管理者可加备注；行内显示最近进展，同部门互看透明度） -->
        <el-tab-pane :label="`成员（${detail.members.length}）`" name="members">
          <div v-if="!detail.members.length" class="muted empty">该部门暂无成员</div>
          <div v-for="m in detail.members" :key="m.id" class="member-row">
            <el-avatar :size="32" :src="m.avatar || undefined">{{ m.name?.slice(0, 1) }}</el-avatar>
            <div class="member-main">
              <div class="member-name">
                <a class="mem-link" @click="$router.push('/members/' + m.id)">{{ m.name }}</a>
                <el-tag v-if="m.isLeader" size="small" type="warning" effect="plain">负责人</el-tag>
                <el-tag v-else-if="m.isManager" size="small" type="warning" effect="plain">共管人</el-tag>
                <el-tag size="small" type="info" effect="plain">{{ ROLE_LABEL[m.role] || m.role }}</el-tag>
                <span class="muted mem-week">本周 {{ m.weekCount }} 篇{{ m.wroteToday ? ' · 今日已交' : ' · 今日未交' }}</span>
              </div>
              <div v-if="m.projects.length" class="member-projs muted ellipsis">
                {{ m.projects.map((p: any) => (p.position ? `${p.name}·${p.position}` : p.name)).join('、') }}
              </div>
              <div v-if="m.lastDaily" class="member-last">
                {{ m.lastDaily.date }}<span v-if="m.lastDaily.hours"> · {{ m.lastDaily.hours }}h</span>
                · {{ m.lastDaily.text || '（无正文）' }}
              </div>
              <div v-else class="member-last muted">近 60 天没有日报</div>
              <div v-if="m.note" class="member-note">
                备注：{{ m.note }}
                <span class="muted">（{{ m.noteBy }} · {{ fmt(m.noteAt, 'MM-DD HH:mm') }}）</span>
              </div>
            </div>
            <el-button v-if="detail.canManage" size="small" text type="primary" @click="editNote(m)">
              {{ m.note ? '编辑备注' : '加备注' }}
            </el-button>
          </div>
        </el-tab-pane>

        <!-- 部门文档 -->
        <el-tab-pane :label="`文档（${docCount}）`" name="docs">
          <div class="doc-toolbar">
            <el-button type="primary" size="small" @click="docVisible = true">
              <el-icon><Plus /></el-icon>&nbsp;上传部门文档
            </el-button>
            <span class="muted">部门文档默认本部门所有人可见，可在知识库中修改可见范围</span>
          </div>
          <div v-if="!docs.length" class="muted empty">暂无部门文档</div>
          <div v-for="d in docs" :key="d.id" class="doc-row" @click="openDoc(d)">
            <el-icon class="doc-icon"><Document /></el-icon>
            <div class="doc-main">
              <div class="doc-title ellipsis">{{ d.title }}</div>
              <div class="muted">{{ d.author?.name }} · {{ timeAgo(d.updatedAt) }}</div>
            </div>
            <el-tag size="small" :type="VIS_TYPE[d.visibility] || 'info'" effect="plain">
              {{ VIS_LABEL[d.visibility] || d.visibility }}
            </el-tag>
          </div>
        </el-tab-pane>
        <!-- 部门文档（二进制文件空间：文件夹/拖拽上传/版本/在线编辑） -->
        <el-tab-pane :label="`文件（${fileCount}）`" name="files">
          <DocumentSpace scope="department" :target-id="deptId" />
        </el-tab-pane>

        <!-- 部门 PBC 互看：成员互相可见本月计划；负责人/管理员可在此审批 -->
        <el-tab-pane :label="`PBC（${pbcDept.length}）`" name="pbc">
          <div class="pbc-toolbar">
            <el-date-picker v-model="pbcMonth" type="month" value-format="YYYY-MM" :clearable="false" @change="loadPbcDept" />
            <el-select v-model="pbcStatusFilter" size="small" placeholder="全部状态">
              <el-option label="全部状态" value="all" />
              <el-option label="未填写" value="DRAFT" />
              <el-option label="待审批" value="SUBMITTED" />
              <el-option label="已退回" value="REJECTED" />
              <el-option label="已通过" value="APPROVED" />
            </el-select>
            <el-button text type="primary" size="small" :loading="pbcLoading" @click="loadPbcDept">刷新</el-button>
            <span class="muted">部门成员可互相查看本月 PBC；负责人/管理员可审批（通过后锁定，需“允许修改”才能重新编辑）或退回修改（附意见）</span>
          </div>
          <PbcRanking :month="pbcMonth" />
          <el-table :data="pbcDeptFiltered" v-loading="pbcLoading" size="small" @row-click="openPbc">
            <el-table-column label="成员" min-width="140" prop="name" sortable>
              <template #default="{ row }">
                {{ row.name }}
                <el-tag v-if="row.isSelf" size="small" type="primary" effect="plain">我</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="合计" width="90">
              <template #default="{ row }">{{ row.hasPbc ? `${row.total} 分 · ${row.itemCount}项` : '—' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90" :sort-method="sortPbcStatus" sortable>
              <template #default="{ row }">
                <el-tag :type="PBSTATUS_TYPE[row.status] || 'info'" size="small" effect="plain">{{ PBSTATUS_LABEL[row.status] || row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="考核" width="110" :sort-by="(r: any) => REVIEW_ORDER[r.reviewStatus] ?? 0" sortable>
              <template #default="{ row }">
                <el-tag v-if="row.hasPbc && row.reviewStatus && row.reviewStatus !== 'NOT_STARTED'" :type="PBREVIEW_TYPE[row.reviewStatus]" size="small" effect="plain">{{ PBREVIEW_LABEL[row.reviewStatus] }}</el-tag>
                <span v-else class="muted">未自评</span>
              </template>
            </el-table-column>
            <el-table-column label="自/终分" width="96">
              <template #default="{ row }">
                <span v-if="row.reviewStatus === 'SELF_DONE'">自评 {{ row.selfTotal ?? 0 }}</span>
                <span v-else-if="row.reviewStatus === 'LEADER_DONE'">{{ row.leaderTotal ?? 0 }} <span class="muted">(自{{ row.selfTotal ?? 0 }})</span></span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="分解" width="84" :sort-by="(r: any) => (r.decomposed ? 1 : 0)" sortable>
              <template #default="{ row }">
                <el-tag v-if="row.hasPbc" :type="row.decomposed ? 'success' : 'info'" size="small" effect="plain">{{ row.decomposed ? '已分解' : '未分解' }}</el-tag>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="130" prop="updatedAt" sortable>
              <template #default="{ row }"><span class="muted">{{ row.updatedAt ? fmt(row.updatedAt, 'MM-DD HH:mm') : '—' }}</span></template>
            </el-table-column>
            <el-table-column label="操作" width="300">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click.stop="openPbc(row)">查看</el-button>
                <el-button v-if="row.canLeaderReview" size="small" text type="warning" @click.stop="openPbc(row)">审核</el-button>
                <el-button v-if="row.canApprove && row.status === 'SUBMITTED'" size="small" text type="success" @click.stop="approveRow(row)">审批通过</el-button>
                <el-button v-if="row.canApprove && row.status === 'APPROVED'" size="small" text type="warning" @click.stop="revokeRow(row)">允许修改</el-button>
                <el-button v-if="auth.isAdmin && row.reviewStatus === 'LEADER_DONE'" size="small" text type="danger" @click.stop="revokeReviewRow(row)">撤销定稿</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!pbcDept.length && !pbcLoading" class="muted empty">该部门暂无成员</div>
        </el-tab-pane>

        <!-- 日报规则（仅管理员/部门负责人）：设定成员多久写一次 + 未写时钉钉提醒 -->
        <el-tab-pane v-if="detail.canManage" label="日报规则" name="report">
          <div v-loading="rsLoading" class="report-rule">
            <el-form label-width="110px" class="rr-form">
              <el-form-item label="写日报频率">
                <el-radio-group v-model="rs.reportFrequency">
                  <el-radio-button value="NONE">不要求</el-radio-button>
                  <el-radio-button value="DAILY">每天</el-radio-button>
                  <el-radio-button value="WORKDAY">每个工作日</el-radio-button>
                  <el-radio-button value="WEEKLY_COUNT">每周N次</el-radio-button>
                </el-radio-group>
                <!-- 频率只是「一周内要写几篇」的要求，个人当天该不该写，一律看他的工作时间安排 -->
                <div class="muted rr-tip rr-freq-tip">
                  以成员在「工作管理 → 我的工作时间安排」里的排班为准：当天排了工作时间就算应写日（没排班的日子不提醒、也不算漏写）。
                  在此前提下，「每天」= 每个排班日都要写；「每个工作日」= 再限定周一~周五；「每周N次」= 一周累计够 N 篇即可。
                </div>
              </el-form-item>
              <el-form-item v-if="rs.reportFrequency === 'WEEKLY_COUNT'" label="每周次数">
                <el-input-number v-model="rs.reportWeeklyCount" :min="1" :max="7" controls-position="right" />
                <span class="muted rr-tip">篇（每周至少写几篇日报）</span>
              </el-form-item>
              <el-form-item label="每日提醒时间">
                <el-time-picker
                  v-model="rs.remindTime"
                  format="HH:mm"
                  value-format="HH:mm"
                  placeholder="提醒时间"
                  :disabled="rs.reportFrequency === 'NONE'"
                />
                <span class="muted rr-tip">北京时间。到点仍未写、且当天在「工作管理 → 我的工作时间安排」里排了班的成员会被钉钉私聊提醒（每人每日最多一次）</span>
              </el-form-item>
              <el-form-item label="通知负责人">
                <el-switch v-model="rs.reportNotifyLeader" />
                <span class="muted rr-tip">成员写完日报/周报/PBC 后实时钉钉私聊通知部门负责人</span>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" :loading="rsSaving" @click="saveReportSetting">保存规则</el-button>
                <el-button @click="loadReportStatus">刷新完成情况</el-button>
              </el-form-item>
            </el-form>

            <div class="rr-status">
              <div class="rr-status-head">
                <span>本周成员日报完成情况</span>
                <span class="muted">（周起 {{ status.weekStart || '-' }} · 今日 {{ status.today || '-' }}）</span>
              </div>
              <el-table :data="status.members || []" size="small">
                <el-table-column label="成员" min-width="120">
                  <template #default="{ row }">
                    {{ row.name }}
                    <el-tag v-if="row.isLeader" size="small" type="warning" effect="plain">负责人</el-tag>
                    <el-tag v-else-if="row.isManager" size="small" type="warning" effect="plain">共管人</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="今日已写" width="96">
                  <template #default="{ row }">
                    <el-tag :type="row.wroteToday ? 'success' : 'info'" size="small" effect="plain">
                      {{ row.wroteToday ? '已写' : '未写' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <!-- 今日排班：取自成员在「工作管理 → 我的工作时间安排」里今天的安排；没排班的人不算应发日报，不会收到提醒 -->
                <el-table-column label="今日排班" min-width="160" show-overflow-tooltip>
                  <template #default="{ row }">
                    <span v-if="row.plannedToday">{{ row.plannedSlots.join('、') }}</span>
                    <span v-else class="muted">未排班（不提醒）</span>
                  </template>
                </el-table-column>
                <el-table-column label="本周已写" width="96">
                  <template #default="{ row }">{{ row.weekCount }} 篇</template>
                </el-table-column>
                <el-table-column label="上次提醒" min-width="140">
                  <template #default="{ row }">
                    <span class="muted">{{ row.lastReportRemindAt ? fmt(row.lastReportRemindAt, 'MM-DD HH:mm') : '未提醒' }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </el-tab-pane>

        <!-- 汇报关系（管理员 + 部门管理者（含共管人））：全公司按直属上级连成汇报树，供 PBC 默认打分上级 -->
        <el-tab-pane v-if="canViewReportTree" label="汇报关系" name="reporttree">
          <div class="rt-toolbar">
            <el-button text type="primary" size="small" :loading="rtLoading" @click="loadReportTree">刷新</el-button>
            <span class="muted">{{
              auth.isAdmin
                ? '点每人右侧「设上级」调整直属上级，全公司连成一棵汇报树：根节点=总负责人，直属根的是一级 leader，其下为二级 leader。PBC 默认打分上级取成员的直属上级。'
                : '你可以调整自己名册内成员的直属上级（新上级只能是你自己或同部门成员）；其他人的行只读。'
            }}</span>
          </div>
          <div v-loading="rtLoading" class="rt-tree">
            <el-tree
              :data="rtRoots"
              :props="{ label: 'name', children: 'children' }"
              node-key="id"
              default-expand-all
              :expand-on-click-node="false"
            >
              <template #default="{ data }">
                <span class="rt-node">
                  <a class="rt-name rt-link" @click.stop="$router.push('/members/' + data.id)">{{ data.name }}</a>
                  <el-tag size="small" type="info" effect="plain">{{ ROLE_LABEL[data.role] || data.role }}</el-tag>
                  <span v-if="data.departmentNames?.length" class="muted rt-dept">{{ data.departmentNames.join(' · ') }}</span>
                  <span v-if="!data.reportsToId && data.defaultReportsToName" class="muted rt-dept">默认：{{ data.defaultReportsToName }}</span>
                  <el-button
                    size="small"
                    text
                    type="primary"
                    :disabled="!rtCanEdit.has(data.id)"
                    @click.stop="openSetParent(data)"
                    >设上级</el-button
                  >
                </span>
              </template>
            </el-tree>
            <div v-if="!rtRoots.length && !rtLoading" class="muted empty">暂无成员</div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <div v-else class="page-card">
      <div v-loading="true" class="muted empty">加载中…</div>
    </div>

    <!-- 文档详情 -->
    <el-drawer v-model="docDetailVisible" :title="currentDoc?.title" size="min(94vw, 640px)">
      <template v-if="currentDoc">
        <div class="muted doc-meta">
          {{ currentDoc.author?.name }} · 更新于 {{ fmt(currentDoc.updatedAt, 'YYYY-MM-DD HH:mm') }} ·
          {{ VIS_LABEL[currentDoc.visibility] || currentDoc.visibility }}
        </div>
        <MarkdownView :content="currentDoc.content" />
      </template>
    </el-drawer>

    <!-- 新建部门文档 -->
    <el-dialog v-model="docVisible" title="上传部门文档" width="min(96vw, 640px)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="标题" required>
          <el-input v-model="docForm.title" maxlength="100" placeholder="文档标题" />
        </el-form-item>
        <el-form-item label="内容（支持 Markdown）">
          <el-input v-model="docForm.content" type="textarea" :rows="10" placeholder="# 标题&#10;&#10;正文…" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="docVisible = false">取消</el-button>
        <el-button type="primary" :loading="docSaving" @click="saveDoc">保存</el-button>
      </template>
    </el-dialog>

    <!-- PBC 查看/审批弹窗（查看自己或他人 PBC 均采用弹窗） -->
    <PbcViewerDialog
      v-model="pbcDlgVisible"
      :row="pbcDlgRow"
      :month="pbcMonth"
      :busy="pbcBusy"
      @approve="approveRow"
      @revoke="revokeRow"
      @reject="rejectRow"
      @decomposed="afterDecision($event.userId)"
      @reviewed="afterDecision($event.userId)"
      @revoke-review="revokeReviewRow"
    />

    <!-- 设置直属上级（仅管理员） -->
    <el-dialog v-model="rtDialogVisible" :title="`设置「${rtTargetName}」的直属上级`" width="min(92vw, 420px)" destroy-on-close>
      <div class="muted" style="margin-bottom:10px">选择新的直属上级（不能选自己或自己的下属）；清空则为置为根（无上级）。</div>
      <div v-if="!auth.isAdmin" class="muted" style="margin-bottom:6px">你只能把成员挂到自己或本部门名册成员下面。</div>
      <el-tree-select
        v-model="rtParentId"
        :data="rtParentOptions"
        :props="{ label: 'name', children: 'children' }"
        node-key="id"
        check-strictly
        :render-after-expand="false"
        default-expand-all
        clearable
        placeholder="选择直属上级（留空=置为根）"
        style="width:100%"
      />
      <template #footer>
        <el-button @click="rtDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="rtSaving" @click="saveReportsTo">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { departmentsApi, knowledgeApi, pbcApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt, timeAgo } from '../utils/format';
import MarkdownView from '../components/MarkdownView.vue';
import DocumentSpace from '../components/DocumentSpace.vue';
import PbcViewerDialog from '../components/PbcViewerDialog.vue';
import PbcRanking from '../components/PbcRanking.vue';

/** embedded：内嵌到「管理后台 → 部门管理」tab 时，隐藏自身页头文字（保留部门切换），由容器提供页面标题 */
defineProps<{ embedded?: boolean }>();

const auth = useAuthStore();
const route = useRoute();

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '系统管理员',
  DEPT_LEADER: '部门负责人',
  PROJECT_LEADER: '项目负责人',
  MEMBER: '成员',
};
const VIS_LABEL: Record<string, string> = {
  PUBLIC: '团队',
  DEPARTMENT: '部门',
  PROJECT: '项目',
  PRIVATE: '个人',
};
const VIS_TYPE: Record<string, string> = {
  PUBLIC: 'info',
  DEPARTMENT: 'success',
  PROJECT: 'primary',
  PRIVATE: 'warning',
};

const deptList = ref<any[]>([]);
const deptId = ref('');
const detail = ref<any>(null);
const docs = ref<any[]>([]);
const tab = ref('projects');
/** 管理员/多部门负责人进入部门页先看「全部部门」汇总，点卡片后看单部门 */
const showAll = ref(false);

const docCount = computed(() => docs.value.length);
const fileCount = computed(() => detail.value?.department?._count?.files ?? 0);

/** 项目行展开的成员名单（一次 detail 就已带回来，展开不再发请求） */
const openProjects = ref<Set<string>>(new Set());
function toggleProj(id: string) {
  const next = new Set(openProjects.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openProjects.value = next;
}

// 可切换的部门：管理员/部门负责人可看全部；普通成员仅自己所在部门
const switchable = computed(() => {
  if (auth.isAdmin || auth.isDeptLeader) return deptList.value;
  return deptList.value.filter((d) => d.id === auth.user?.departmentId);
});

async function loadDetail() {
  if (!deptId.value) return;
  detail.value = await departmentsApi.detail(deptId.value);
  openProjects.value = new Set();
  docs.value = await knowledgeApi.list({ departmentId: deptId.value }).catch(() => []);
  if (tab.value === 'pbc') loadPbcDept();
}

function openDept(id: string) {
  deptId.value = id;
  showAll.value = false;
  tab.value = 'projects';
  loadDetail();
}

async function editNote(m: any) {
  const { value } = await ElMessageBox.prompt(`为「${m.name}」填写备注（留空删除）`, '成员备注', {
    inputValue: m.note || '',
    inputType: 'textarea',
    confirmButtonText: '保存',
  });
  await departmentsApi.setNote(deptId.value, m.id, value || '');
  ElMessage.success(value?.trim() ? '备注已保存' : '备注已删除');
  await loadDetail();
}

// ---- 部门 PBC 互看（成员互相可见，负责人/管理员可审批）----
const PBSTATUS_LABEL: Record<string, string> = { DRAFT: '未填写', SUBMITTED: '待审批', APPROVED: '已通过', REJECTED: '已退回' };
const PBSTATUS_TYPE: Record<string, string> = { DRAFT: 'info', SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger' };
// PBC 状态排序权重：未填→待审批→已退回→已通过
const PB_ORDER: Record<string, number> = { DRAFT: 0, SUBMITTED: 1, REJECTED: 2, APPROVED: 3 };
// 考核轴（与计划审批独立）
const PBREVIEW_LABEL: Record<string, string> = { NOT_STARTED: '未自评', SELF_DONE: '已自评·待评分', LEADER_DONE: '已定稿' };
const PBREVIEW_TYPE: Record<string, string> = { NOT_STARTED: 'info', SELF_DONE: 'warning', LEADER_DONE: 'success' };
const REVIEW_ORDER: Record<string, number> = { NOT_STARTED: 0, SELF_DONE: 1, LEADER_DONE: 2 };
function sortPbcStatus(a: any, b: any) {
  return (PB_ORDER[a.status] ?? 9) - (PB_ORDER[b.status] ?? 9);
}
/** 当前北京口径月份 'YYYY-MM' */
function bjMonth(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
}
const pbcMonth = ref(bjMonth());
const pbcDept = ref<any[]>([]);
const pbcStatusFilter = ref<string>('all');
/** 按状态筛选后的部门 PBC 行（部门内单一部门，无需部门筛选） */
const pbcDeptFiltered = computed(() =>
  pbcStatusFilter.value === 'all' ? pbcDept.value : pbcDept.value.filter((r) => r.status === pbcStatusFilter.value),
);
const pbcLoading = ref(false);
const pbcBusy = ref(false);
const pbcDlgVisible = ref(false);
const pbcDlgRow = ref<any>(null);

async function loadPbcDept() {
  if (!deptId.value) return;
  pbcLoading.value = true;
  try {
    pbcDept.value = await pbcApi.dept(deptId.value, pbcMonth.value);
  } catch {
    pbcDept.value = [];
  } finally {
    pbcLoading.value = false;
  }
}

function openPbc(row: any) {
  pbcDlgRow.value = row;
  pbcDlgVisible.value = true;
}

/** 审批/撤回后刷新列表，若弹窗仍开着同步该行状态 */
async function afterDecision(userId: string) {
  await loadPbcDept();
  if (pbcDlgVisible.value) pbcDlgRow.value = pbcDept.value.find((r) => r.userId === userId) ?? null;
}

async function approveRow(row: any) {
  pbcBusy.value = true;
  try {
    await pbcApi.approve(row.userId, pbcMonth.value);
    ElMessage.success('该 PBC 已审批通过并锁定');
    await afterDecision(row.userId);
  } finally {
    pbcBusy.value = false;
  }
}

async function revokeRow(row: any) {
  pbcBusy.value = true;
  try {
    await pbcApi.revoke(row.userId, pbcMonth.value);
    ElMessage.success('已允许该成员修改');
    await afterDecision(row.userId);
  } finally {
    pbcBusy.value = false;
  }
}

/** 撤销定稿（仅 ADMIN）：考核回到「已自评·待复核」，保留分数并留痕 */
async function revokeReviewRow(row: any) {
  try {
    const { value } = await ElMessageBox.prompt(
      `撤销 ${row.name} ${pbcMonth.value} 的定稿，考核回到「已自评·待复核」，会通知成员与打分上级。可填写撤销原因：`,
      '撤销定稿',
      { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消', inputPlaceholder: '选填' },
    );
    pbcBusy.value = true;
    await pbcApi.revokeLeaderReview(row.userId, pbcMonth.value, String(value ?? '').trim() || undefined);
    ElMessage.success('已撤销定稿');
    await afterDecision(row.userId);
  } catch {
    /* 取消 */
  } finally {
    pbcBusy.value = false;
  }
}

/** 退回修改（来弹窗 emit）：携 {row, comment}，退回后刷新并关闭弹窗 */
async function rejectRow(payload: { row: any; comment: string }) {
  pbcBusy.value = true;
  try {
    await pbcApi.reject(payload.row.userId, pbcMonth.value, payload.comment);
    ElMessage.success('已退回并钉钉通知成员修改');
    pbcDlgVisible.value = false;
    await loadPbcDept();
  } finally {
    pbcBusy.value = false;
  }
}

// ---- 部门文档 ----
const docVisible = ref(false);
const docSaving = ref(false);
const docForm = reactive({ title: '', content: '' });
const docDetailVisible = ref(false);
const currentDoc = ref<any>(null);

async function openDoc(d: any) {
  currentDoc.value = await knowledgeApi.get(d.id).catch(() => d);
  docDetailVisible.value = true;
}

async function saveDoc() {
  if (!docForm.title.trim()) {
    ElMessage.warning('请输入标题');
    return;
  }
  docSaving.value = true;
  try {
    await knowledgeApi.create({
      title: docForm.title.trim(),
      content: docForm.content,
      visibility: 'DEPARTMENT',
      departmentId: deptId.value,
    });
    ElMessage.success('部门文档已上传');
    docVisible.value = false;
    Object.assign(docForm, { title: '', content: '' });
    await loadDetail();
  } finally {
    docSaving.value = false;
  }
}

// ---- 日报规则（仅管理员/部门负责人）----
const rs = reactive({
  reportFrequency: 'NONE',
  reportWeeklyCount: null as number | null,
  remindTime: '20:00',
  reportNotifyLeader: true,
});
const status = ref<any>({});
const rsLoading = ref(false);
const rsSaving = ref(false);

/** 拉取部门日报规则（后端字段 reportRemindTime 映射为 rs.remindTime） */
async function loadReportSetting() {
  if (!deptId.value) return;
  rsLoading.value = true;
  try {
    const s: any = await departmentsApi.getReportSetting(deptId.value);
    rs.reportFrequency = s.reportFrequency ?? 'NONE';
    rs.reportWeeklyCount = s.reportWeeklyCount ?? null;
    rs.remindTime = s.reportRemindTime ?? '20:00';
    rs.reportNotifyLeader = s.reportNotifyLeader ?? true;
  } finally {
    rsLoading.value = false;
  }
}

/** 拉取本周成员日报完成情况 */
async function loadReportStatus() {
  if (!deptId.value) return;
  try {
    status.value = await departmentsApi.reportStatus(deptId.value);
  } catch {
    status.value = {};
  }
}

/** 保存日报规则（提醒时间映射回 reportRemindTime） */
async function saveReportSetting() {
  rsSaving.value = true;
  try {
    await departmentsApi.saveReportSetting(deptId.value, {
      reportFrequency: rs.reportFrequency,
      reportWeeklyCount: rs.reportWeeklyCount,
      reportRemindTime: rs.remindTime,
      reportNotifyLeader: rs.reportNotifyLeader,
    });
    ElMessage.success('日报规则已保存');
    await loadReportStatus();
  } finally {
    rsSaving.value = false;
  }
}

// 首次切到「日报规则」/「PBC」/「汇报关系」标签时加载
watch(tab, (t) => {
  if (t === 'report' && detail.value?.canManage) {
    loadReportSetting();
    loadReportStatus();
  }
  if (t === 'pbc') loadPbcDept();
  if (t === 'reporttree' && canViewReportTree.value) loadReportTree();
});

// ---- 汇报树（管理员可改任意人；部门管理者可读全树、只可改自己名册）----
const canViewReportTree = computed(() => auth.isAdmin || auth.roleRank >= 2);
const rtRoots = ref<any[]>([]);
const rtFlat = ref<any[]>([]);
const rtCanEdit = ref<Set<string>>(new Set());
const rtLoading = ref(false);
const rtSaving = ref(false);
const rtDialogVisible = ref(false);
const rtParentId = ref<string | null>(null);
const rtTarget = ref<any>(null);
const rtTargetName = computed(() => rtTarget.value?.name ?? '');

async function loadReportTree() {
  rtLoading.value = true;
  try {
    const r = await departmentsApi.reportTree();
    rtRoots.value = r.roots ?? [];
    rtFlat.value = r.flat ?? [];
    rtCanEdit.value = new Set(r.canEditIds ?? []);
  } finally {
    rtLoading.value = false;
  }
}

/** 从候选树中剪掉某人自身及其整棵子树（不能选自己或后代为上级） */
function pruneSubtree(nodes: any[], excludeId: string): any[] {
  const out: any[] = [];
  for (const n of nodes) {
    if (n.id === excludeId) continue;
    out.push({ ...n, children: pruneSubtree(n.children ?? [], excludeId) });
  }
  return out;
}
/**
 * 上级候选：管理员看全树（剪掉自己及后代）；部门管理者只列自己名册内成员 + 我自己
 * （后端也这么校，候选先收敛一层，避免选了看不见的人再挨一个 403）
 */
const rtParentOptions = computed(() => {
  if (auth.isAdmin) return rtTarget.value ? pruneSubtree(rtRoots.value, rtTarget.value.id) : rtRoots.value;
  const list = rtFlat.value.filter((f: any) => rtCanEdit.value.has(f.id) || f.id === auth.user?.id);
  return list.map((f: any) => ({ id: f.id, name: f.departmentNames?.length ? `${f.name}（${f.departmentNames.join('·')}）` : f.name }));
});

function openSetParent(node: any) {
  rtTarget.value = node;
  rtParentId.value = node.reportsToId ?? null;
  rtDialogVisible.value = true;
}

async function saveReportsTo() {
  if (!rtTarget.value) return;
  rtSaving.value = true;
  try {
    await departmentsApi.setReportsTo(rtTarget.value.id, rtParentId.value || null);
    ElMessage.success(rtParentId.value ? '已更新直属上级' : '已置为根（无上级）');
    rtDialogVisible.value = false;
    await loadReportTree();
  } finally {
    rtSaving.value = false;
  }
}

onMounted(async () => {
  deptList.value = await departmentsApi.list().catch(() => []);
  const own = auth.user?.departmentId;
  const first = switchable.value[0]?.id || deptList.value[0]?.id || '';
  // 首页/管理后台的部门 tag 带 ?id= 直达指定部门（多部门的人能从自己任一部门进）
  const qid = String(route.query.id || '');
  deptId.value = qid && deptList.value.some((d) => d.id === qid) ? qid : own && deptList.value.some((d) => d.id === own) ? own : first;
  showAll.value = !qid && switchable.value.length > 1;
  await loadDetail();
});
</script>

<style scoped>
.all-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.all-title {
  font-size: var(--fs-lg);
  font-weight: 600;
}
.dept-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}
.dept-card {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.dept-card:hover {
  border-color: var(--el-color-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.dept-card-on {
  border-color: var(--el-color-primary);
  background: #f4f8ff;
}
.dept-card-name {
  font-size: 14px;
  font-weight: 600;
}
.dept-card-leader {
  font-size: 12px;
  margin-top: 4px;
}
.dept-card-stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #909399;
  margin-top: 6px;
}
.dept-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dept-name {
  font-size: var(--fs-lg);
  font-weight: 700;
}
.dept-meta {
  margin-top: 6px;
  font-size: 13px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.dept-desc {
  margin-top: 8px;
  font-size: 13px;
}
/* 卡内页签：做成卡片顶部的浅宝蓝条带（跟全局胶囊页签同一 token 体系），与下方数据区拉开层次 */
.dept-tabs :deep(.el-tabs__header) {
  margin: calc(-1 * var(--card-pad)) calc(-1 * var(--card-pad)) var(--sp-3);
  padding: 8px var(--card-pad) 0;
  background: var(--app-band);
  border-bottom: 1px solid var(--app-border);
  border-radius: 9px 9px 0 0;
}
.dept-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}
.proj-row,
.doc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
  font-size: 14px;
}
.proj-row:last-child,
.doc-row:last-child {
  border-bottom: none;
}
.proj-row:hover,
.doc-row:hover {
  background: #f8fafc;
}
.proj-row .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.proj-name {
  font-weight: 600;
  flex: 1;
  min-width: 0;
}
/* 项目行：整行不再一点就跳走（改由名称/色点跳转），行首留展开箭头给成员名单 */
.proj-row {
  cursor: default;
  flex-wrap: wrap;
}
.proj-row .proj-name,
.proj-row .dot {
  cursor: pointer;
}
.proj-row .proj-name:hover {
  color: var(--el-color-primary);
}
.proj-caret {
  display: inline-flex;
  align-items: center;
  color: var(--chip-ink);
  cursor: pointer;
  padding: 2px;
}
.proj-members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 4px 10px 24px;
  background: #f8fafc;
  border-radius: var(--r-sm);
  margin-bottom: 6px;
}
.pm-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #fff;
  border: 1px solid var(--chip-line);
  border-radius: var(--r-pill);
  padding: 3px 10px 3px 4px;
  font-size: var(--fs-xs);
}
/* 非本部门成员（项目里带进来的外部协作人）：置灰区分 */
.pm-chip-out {
  background: #f2f4f7;
  border-color: #e4e7ed;
  opacity: 0.85;
}
.pm-name {
  color: var(--app-heading-2);
  cursor: pointer;
  font-weight: 500;
}
.pm-note {
  flex-basis: 100%;
  font-size: var(--fs-2xs);
}
.mem-link {
  color: inherit;
  cursor: pointer;
}
.mem-link:hover {
  color: var(--el-color-primary);
}
.mem-week {
  font-size: var(--fs-2xs);
  margin-left: auto;
  flex-shrink: 0;
}
.member-last {
  font-size: var(--fs-xs);
  margin-top: 3px;
  color: #6b7a8f;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.dept-mgr {
  color: var(--app-heading-2);
  cursor: pointer;
}
.rt-link {
  color: inherit;
  cursor: pointer;
}
.rt-link:hover {
  color: var(--el-color-primary);
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid #f5f7fa;
}
.member-row:last-child {
  border-bottom: none;
}
.member-main {
  flex: 1;
  min-width: 0;
}
.member-name {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}
.member-projs {
  font-size: 12px;
  margin-top: 2px;
}
.member-note {
  font-size: 12px;
  margin-top: 2px;
  color: #e6a23c;
}
.doc-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.doc-icon {
  color: var(--el-color-primary);
}
.doc-main {
  flex: 1;
  min-width: 0;
}
.doc-title {
  font-size: 14px;
  font-weight: 500;
}
.doc-meta {
  margin-bottom: 12px;
}
.pbc-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
/* 频率说明单独占一行：el-form-item__content 是 flex，不给整行宽会被排到按钮同一列 */
.rr-freq-tip {
  flex-basis: 100%;
  margin-top: 6px;
  line-height: 1.7;
}
/* 汇报关系树 */
.rt-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.rt-tree {
  min-height: 60px;
}
.rt-node {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rt-name {
  font-weight: 500;
}
.rt-dept {
  font-size: 12px;
}
</style>
