<template>
  <div class="page">
    <div class="page-head">
      <div class="head-main">
        <div class="page-title">项目盘点</div>
        <div class="muted small">服务知识台账：项目形态 / 管理员 / 服务器 / 域名 一眼看全</div>
      </div>
      <div class="stat-row">
        <div class="stat"><span class="stat-n">{{ inventories.length }}</span><span class="stat-k">盘点条目</span></div>
        <div class="stat"><span class="stat-n">{{ servers.length }}</span><span class="stat-k">服务器</span></div>
        <div class="stat"><span class="stat-n">{{ domains.length }}</span><span class="stat-k">域名</span></div>
      </div>
    </div>

    <el-alert
      v-if="!auth.isAdmin"
      class="scope-tip"
      type="info"
      :closable="false"
      show-icon
      title="你只能看到并管理自己上传的记录；管理员可查看全部。"
    />

    <el-tabs v-model="activeTab" class="inv-tabs">
      <!-- ================= 项目盘点 ================= -->
      <el-tab-pane label="项目盘点" name="inventory">
        <div class="bar">
          <div class="bar-left">
            <el-input
              v-model="keyword"
              class="search"
              clearable
              placeholder="搜索项目 / 管理员 / 负责人 / 备注 / IP / 域名"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <span class="muted small">共 {{ filteredInventories.length }} / {{ inventories.length }} 条</span>
          </div>
          <div class="bar-right">
            <el-radio-group v-model="viewMode" size="small" class="view-switch">
              <el-radio-button value="card">卡片视图</el-radio-button>
              <el-radio-button value="table">表格视图</el-radio-button>
            </el-radio-group>
            <el-button type="primary" @click="openInventory()">
              <el-icon><Plus /></el-icon>&nbsp;新增盘点
            </el-button>
          </div>
        </div>

        <!-- ===== 卡片视图：一屏看完一个项目的形态/管理员/关联 ===== -->
        <div v-if="viewMode === 'card'" v-loading="loading" class="cards">
          <div v-if="!filteredInventories.length" class="empty">暂无盘点记录</div>
          <article v-for="row in filteredInventories" :key="row.id" class="inv-card">
            <header class="card-hd">
              <div class="card-title" :title="row.title">{{ row.title }}</div>
              <div class="card-forms">
                <el-tag v-for="f in row.forms" :key="f" size="small" effect="plain" class="tag">{{ formLabel(f) }}</el-tag>
                <el-tag v-if="row.hasMiniProgram" size="small" type="success" effect="plain" class="tag">小程序</el-tag>
              </div>
            </header>
            <div class="card-sub">
              <template v-if="row.project">关联：{{ row.project.name }}</template>
              <template v-else>手动 / 历史项目</template>
            </div>
            <div class="card-links">
              <a v-if="row.websiteUrl" :href="withProto(row.websiteUrl)" target="_blank" rel="noopener" class="link">{{ row.websiteUrl }}</a>
              <a v-if="row.githubUrl" :href="withProto(row.githubUrl)" target="_blank" rel="noopener" class="link">GitHub</a>
              <span v-if="row.miniProgramName" class="muted small">小程序：{{ row.miniProgramName }}</span>
              <span v-if="!row.websiteUrl && !row.githubUrl && !row.miniProgramName" class="muted small">无外链</span>
            </div>
            <div class="card-meta">
              <div class="meta-item">
                <span class="meta-k">目前管理员</span>
                <span class="meta-v" :class="{ 'meta-empty': !row.admin }">{{ row.admin || '未填写' }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-k">负责人</span>
                <span class="meta-v" :class="{ 'meta-empty': !row.owner }">{{ row.owner?.name || '未填写' }}</span>
              </div>
            </div>
            <div class="card-rel">
              <div class="rel-line">
                <span class="rel-k">服务器</span>
                <span v-if="!row.servers?.length" class="muted small">未关联</span>
                <el-tag v-for="s in row.servers" :key="s.id" size="small" effect="plain" class="tag">{{ s.server.name || s.server.ip }}</el-tag>
              </div>
              <div class="rel-line">
                <span class="rel-k">域名</span>
                <span v-if="!row.domains?.length" class="muted small">未关联</span>
                <el-tag v-for="d in row.domains" :key="d.id" size="small" type="warning" effect="plain" class="tag">{{ d.domain.domain }}</el-tag>
              </div>
            </div>
            <div v-if="row.remark" class="card-remark" :title="row.remark">{{ row.remark }}</div>
            <footer class="card-ft">
              <span class="muted small">{{ auth.isAdmin ? '创建人：' + (row.creator?.name || '-') : '' }}</span>
              <span class="ft-ops">
                <el-button size="small" text type="primary" @click="openInventory(row)">编辑</el-button>
                <el-button size="small" text type="danger" @click="delInventory(row)">删除</el-button>
              </span>
            </footer>
          </article>
        </div>

        <!-- ===== 表格视图：字段对齐，便于横向比对 ===== -->
        <el-table v-else v-loading="loading" :data="filteredInventories" class="tbl" empty-text="暂无盘点记录">
          <el-table-column label="项目 / 名称" min-width="160">
            <template #default="{ row }">
              <div class="cell-strong">{{ row.title }}</div>
              <div v-if="row.project" class="muted small">关联：{{ row.project.name }}</div>
              <div v-else class="muted small">手动/历史项目</div>
            </template>
          </el-table-column>
          <el-table-column label="形态" min-width="150">
            <template #default="{ row }">
              <el-tag v-for="f in row.forms" :key="f" size="small" effect="plain" class="tag">{{ formLabel(f) }}</el-tag>
              <el-tag v-if="row.hasMiniProgram" size="small" type="success" effect="plain" class="tag">小程序</el-tag>
              <span v-if="!row.forms?.length && !row.hasMiniProgram" class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="网址 / 小程序" min-width="180">
            <template #default="{ row }">
              <a v-if="row.websiteUrl" :href="withProto(row.websiteUrl)" target="_blank" rel="noopener" class="link">{{ row.websiteUrl }}</a>
              <div v-if="row.miniProgramName" class="muted small">小程序：{{ row.miniProgramName }}</div>
              <span v-if="!row.websiteUrl && !row.miniProgramName" class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="GitHub" min-width="160">
            <template #default="{ row }">
              <a v-if="row.githubUrl" :href="withProto(row.githubUrl)" target="_blank" rel="noopener" class="link">{{ row.githubUrl }}</a>
              <div v-if="row.githubAccount" class="muted small">账号：{{ row.githubAccount }}</div>
              <span v-if="!row.githubUrl && !row.githubAccount" class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="目前管理员" min-width="140">
            <template #default="{ row }">
              <span v-if="row.admin" class="cell-strong">{{ row.admin }}</span>
              <span v-else class="muted">未填写</span>
            </template>
          </el-table-column>
          <el-table-column label="负责人" width="100">
            <template #default="{ row }">{{ row.owner?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="所用服务器" min-width="150">
            <template #default="{ row }">
              <span v-if="!row.servers?.length" class="muted">-</span>
              <el-tag v-for="s in row.servers" :key="s.id" size="small" effect="plain" class="tag">{{ s.server.name || s.server.ip }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="所用域名" min-width="150">
            <template #default="{ row }">
              <span v-if="!row.domains?.length" class="muted">-</span>
              <el-tag v-for="d in row.domains" :key="d.id" size="small" type="warning" effect="plain" class="tag">{{ d.domain.domain }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="160">
            <template #default="{ row }">
              <span v-if="row.remark" class="remark-cell" :title="row.remark">{{ row.remark }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column v-if="auth.isAdmin" label="创建人" width="100">
            <template #default="{ row }">{{ row.creator?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openInventory(row)">编辑</el-button>
              <el-button size="small" text type="danger" @click="delInventory(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ================= 服务器台账 ================= -->
      <el-tab-pane label="服务器台账" name="server">
        <div class="bar">
          <span class="muted">共 {{ servers.length }} 台服务器（服务知识：名称 / IP / 云厂商 / 负责人）</span>
          <el-button type="primary" @click="openServer()">
            <el-icon><Plus /></el-icon>&nbsp;新增服务器
          </el-button>
        </div>
        <el-table v-loading="loading" :data="servers" class="tbl" empty-text="暂无服务器">
          <el-table-column prop="name" label="名称" min-width="130">
            <template #default="{ row }">
              <span v-if="row.name" class="cell-strong">{{ row.name }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" min-width="140" />
          <el-table-column prop="label" label="标注" min-width="130">
            <template #default="{ row }">{{ row.label || '-' }}</template>
          </el-table-column>
          <el-table-column prop="provider" label="云厂商/归属" min-width="120" />
          <el-table-column prop="region" label="地域" min-width="100">
            <template #default="{ row }">{{ row.region || '-' }}</template>
          </el-table-column>
          <el-table-column prop="spec" label="配置" min-width="120">
            <template #default="{ row }">{{ row.spec || '-' }}</template>
          </el-table-column>
          <el-table-column prop="usage" label="用途" min-width="140">
            <template #default="{ row }">{{ row.usage || '-' }}</template>
          </el-table-column>
          <el-table-column label="到期" width="120">
            <template #default="{ row }">{{ fmt(row.expireAt, 'YYYY-MM-DD') }}</template>
          </el-table-column>
          <el-table-column label="负责人" width="100">
            <template #default="{ row }">{{ row.owner?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="关联" width="140">
            <template #default="{ row }">
              <span class="muted small">{{ row._count?.projects ?? 0 }} 项目 · {{ row._count?.domains ?? 0 }} 域名</span>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="160">
            <template #default="{ row }">
              <span v-if="row.remark" class="remark-cell" :title="row.remark">{{ row.remark }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column v-if="auth.isAdmin" label="创建人" width="100">
            <template #default="{ row }">{{ row.creator?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openServer(row)">编辑</el-button>
              <el-button size="small" text type="danger" @click="delServer(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ================= 域名台账 ================= -->
      <el-tab-pane label="域名台账" name="domain">
        <div class="bar">
          <span class="muted">共 {{ domains.length }} 个域名（服务知识：性质 / 负责人 / 解析服务器）</span>
          <el-button type="primary" @click="openDomain()">
            <el-icon><Plus /></el-icon>&nbsp;新增域名
          </el-button>
        </div>
        <el-table v-loading="loading" :data="domains" class="tbl" empty-text="暂无域名">
          <el-table-column prop="domain" label="域名" min-width="170" />
          <el-table-column label="性质" width="90">
            <template #default="{ row }">
              <el-tag :type="row.nature === 'ENTERPRISE' ? 'success' : 'info'" size="small" effect="plain">
                {{ row.nature === 'ENTERPRISE' ? '企业' : '个人' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="registrar" label="注册商" min-width="110">
            <template #default="{ row }">{{ row.registrar || '-' }}</template>
          </el-table-column>
          <el-table-column prop="filing" label="ICP备案" min-width="130">
            <template #default="{ row }">{{ row.filing || '-' }}</template>
          </el-table-column>
          <el-table-column label="到期" width="120">
            <template #default="{ row }">{{ fmt(row.expireAt, 'YYYY-MM-DD') }}</template>
          </el-table-column>
          <el-table-column label="负责人" width="100">
            <template #default="{ row }">{{ row.owner?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="解析/关联服务器" min-width="160">
            <template #default="{ row }">
              <span v-if="!row.servers?.length" class="muted">-</span>
              <el-tag v-for="s in row.servers" :key="s.id" size="small" effect="plain" class="tag">{{ s.server.name || s.server.ip }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="160">
            <template #default="{ row }">
              <span v-if="row.remark" class="remark-cell" :title="row.remark">{{ row.remark }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column v-if="auth.isAdmin" label="创建人" width="100">
            <template #default="{ row }">{{ row.creator?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="openDomain(row)">编辑</el-button>
              <el-button size="small" text type="danger" @click="delDomain(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 项目盘点弹窗 ============ -->
    <el-dialog v-model="invDialog" :title="editingInv ? '编辑盘点' : '新增盘点'" width="min(94vw, 640px)" align-center>
      <el-form label-position="top">
        <el-form-item label="项目 / 盘点名称" required>
          <el-input v-model="invForm.title" maxlength="60" placeholder="如：官网 / 小程序后端" />
        </el-form-item>
        <el-form-item label="关联已有项目（可空，用于历史/手动项目）">
          <el-select v-model="invForm.projectId" clearable filterable placeholder="选择已有项目" style="width: 100%" @change="onPickProject">
            <el-option v-for="p in pickProjects" :key="p.id" :label="p.archived ? p.name + '（已归档）' : p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="当前形态（可多选）">
          <el-checkbox-group v-model="invForm.forms">
            <el-checkbox v-for="f in FORM_OPTIONS" :key="f.value" :value="f.value">{{ f.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <div class="row">
          <el-form-item label="项目网址" class="half">
            <el-input v-model="invForm.websiteUrl" placeholder="https://..." />
          </el-form-item>
          <el-form-item label="负责人" class="half">
            <el-select v-model="invForm.ownerId" clearable filterable placeholder="选择负责人" style="width: 100%">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="目前的管理员">
          <el-autocomplete
            v-model="invForm.admin"
            :fetch-suggestions="suggestAdmins"
            clearable
            placeholder="直接输入：张三 / admin@xx.com / 139xxxx；也可选成员"
            style="width: 100%"
          />
          <div class="muted small form-tip">系统/平台当前的实际管理员（可与项目负责人不同）：可填姓名、账号或联系方式</div>
        </el-form-item>
        <el-form-item label="是否有小程序">
          <el-switch v-model="invForm.hasMiniProgram" />
        </el-form-item>
        <el-form-item v-if="invForm.hasMiniProgram" label="小程序名称">
          <el-input v-model="invForm.miniProgramName" maxlength="60" />
        </el-form-item>
        <div class="row">
          <el-form-item label="GitHub 链接" class="half">
            <el-input v-model="invForm.githubUrl" placeholder="https://github.com/..." />
          </el-form-item>
          <el-form-item label="GitHub 账号" class="half" :required="!!invForm.githubUrl.trim()">
            <el-input v-model="invForm.githubAccount" placeholder="组织/个人账号" />
            <div v-if="invForm.githubUrl.trim() && !invForm.githubAccount.trim()" class="err-tip">已填 GitHub 链接，必须再填 GitHub 账号</div>
          </el-form-item>
        </div>
        <el-form-item label="所用服务器">
          <el-select v-model="invForm.serverIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="从服务器台账选择" style="width: 100%">
            <el-option v-for="s in servers" :key="s.id" :label="serverOptionLabel(s)" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="所用域名">
          <el-select v-model="invForm.domainIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="从域名台账选择" style="width: 100%">
            <el-option v-for="d in domains" :key="d.id" :label="`${d.domain}${d.nature === 'PERSONAL' ? '（个人）' : ''}`" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="invForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="invDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveInventory">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 服务器弹窗 ============ -->
    <el-dialog v-model="serverDialog" :title="editingServer ? '编辑服务器' : '新增服务器'" width="min(94vw, 560px)" align-center>
      <el-form label-position="top">
        <div class="row">
          <el-form-item label="名称（约定名称）" class="half">
            <el-input v-model="serverForm.name" placeholder="如：考公服务器" />
          </el-form-item>
          <el-form-item label="服务器 IP" required class="half">
            <el-input v-model="serverForm.ip" placeholder="如：124.223.100.121" />
          </el-form-item>
        </div>
        <div class="row">
          <el-form-item label="标注" class="half">
            <el-input v-model="serverForm.label" placeholder="如：生产主服务器" />
          </el-form-item>
          <el-form-item label="云厂商/归属" required class="half">
            <el-select v-model="serverForm.provider" filterable allow-create default-first-option placeholder="选择或输入" style="width: 100%">
              <el-option v-for="p in PROVIDER_OPTIONS" :key="p" :label="p" :value="p" />
            </el-select>
          </el-form-item>
        </div>
        <div class="row">
          <el-form-item label="地域" class="half">
            <el-input v-model="serverForm.region" placeholder="如：上海" />
          </el-form-item>
          <el-form-item label="配置" class="half">
            <el-input v-model="serverForm.spec" placeholder="CPU/内存/带宽" />
          </el-form-item>
        </div>
        <div class="row">
          <el-form-item label="到期时间" class="half">
            <el-date-picker v-model="serverForm.expireAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
          </el-form-item>
          <el-form-item label="负责人" class="half">
            <el-select v-model="serverForm.ownerId" clearable filterable placeholder="选择负责人" style="width: 100%">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="用途">
          <el-input v-model="serverForm.usage" placeholder="承载哪些服务" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="serverForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="serverDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveServer">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 域名弹窗 ============ -->
    <el-dialog v-model="domainDialog" :title="editingDomain ? '编辑域名' : '新增域名'" width="min(94vw, 560px)" align-center>
      <el-form label-position="top">
        <div class="row">
          <el-form-item label="域名" required class="half">
            <el-input v-model="domainForm.domain" placeholder="如：example.com" />
          </el-form-item>
          <el-form-item label="性质" class="half">
            <el-select v-model="domainForm.nature" style="width: 100%">
              <el-option label="企业" value="ENTERPRISE" />
              <el-option label="个人" value="PERSONAL" />
            </el-select>
          </el-form-item>
        </div>
        <div class="row">
          <el-form-item label="注册商" class="half">
            <el-input v-model="domainForm.registrar" placeholder="如：腾讯云 / 万网" />
          </el-form-item>
          <el-form-item label="ICP 备案" class="half">
            <el-input v-model="domainForm.filing" placeholder="备案号" />
          </el-form-item>
        </div>
        <div class="row">
          <el-form-item label="到期时间" class="half">
            <el-date-picker v-model="domainForm.expireAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width: 100%" />
          </el-form-item>
          <el-form-item label="负责人" class="half">
            <el-select v-model="domainForm.ownerId" clearable filterable placeholder="选择负责人" style="width: 100%">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="解析/关联服务器">
          <el-select v-model="domainForm.serverIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择该域名解析到的服务器" style="width: 100%">
            <el-option v-for="s in servers" :key="s.id" :label="serverOptionLabel(s)" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="domainForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="domainDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDomain">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Search } from '@element-plus/icons-vue';
import dayjs from 'dayjs';
import { inventoryApi, usersApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt } from '../utils/format';

const auth = useAuthStore();

const activeTab = ref('inventory');
const loading = ref(false);
const saving = ref(false);

const FORM_OPTIONS = [
  { label: '网页', value: 'WEB' },
  { label: 'APP', value: 'APP' },
  { label: '小程序', value: 'MINIPROGRAM' },
  { label: '后端', value: 'BACKEND' },
  { label: '其他', value: 'OTHER' },
];
const PROVIDER_OPTIONS = ['腾讯云', '阿里云', '华为云', '自建机房', '其他'];

const inventories = ref<any[]>([]);
const servers = ref<any[]>([]);
const domains = ref<any[]>([]);
const pickProjects = ref<any[]>([]);
const users = ref<any[]>([]);

// 视图方式：卡片（默认，一屏看全一条）/ 表格（字段对齐横向比对），记住上次选择
const VIEW_KEY = 'inventory-view-mode';
const viewMode = ref<'card' | 'table'>(localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'card');
watch(viewMode, (v) => localStorage.setItem(VIEW_KEY, v));

const keyword = ref('');
/** 关键字跨字段匹配：项目名 / 管理员 / 负责人 / 备注 / 外链 / 关联的服务器与域名 */
const filteredInventories = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return inventories.value;
  const hit = (v: any) => String(v ?? '').toLowerCase().includes(kw);
  return inventories.value.filter((r) => {
    if (
      hit(r.title) || hit(r.admin) || hit(r.owner?.name) || hit(r.remark) ||
      hit(r.websiteUrl) || hit(r.githubUrl) || hit(r.githubAccount) || hit(r.miniProgramName)
    ) return true;
    if ((r.servers || []).some((s: any) => hit(s.server?.name) || hit(s.server?.ip) || hit(s.server?.label) || hit(s.server?.provider))) return true;
    if ((r.domains || []).some((d: any) => hit(d.domain?.domain))) return true;
    return false;
  });
});

function formLabel(v: string) {
  return FORM_OPTIONS.find((f) => f.value === v)?.label ?? v;
}
/** 「目前的管理员」联想：直接输入也能落库，输入时再把成员名作为候选 （比 allow-create 下拉更不容易输不进去） */
function suggestAdmins(q: string, cb: (arr: { value: string }[]) => void) {
  const kw = (q || '').trim();
  const list = users.value
    .filter((u) => !kw || String(u.name || '').includes(kw))
    .slice(0, 8)
    .map((u) => ({ value: u.name }));
  cb(list);
}
function withProto(u: string) {
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}
/** 服务器在下拉/标签里的展示：名称优先，其次 IP，再带标注 */
function serverOptionLabel(s: any) {
  const base = s.name || s.ip;
  return `${base}${s.ip && s.name ? ' · ' + s.ip : ''}${s.label ? ' · ' + s.label : ''}`;
}

async function loadAll() {
  loading.value = true;
  try {
    const [inv, srv, dom, pp, us] = await Promise.all([
      inventoryApi.list(),
      inventoryApi.servers(),
      inventoryApi.domains(),
      inventoryApi.pickableProjects(),
      usersApi.list(),
    ]);
    inventories.value = inv;
    servers.value = srv;
    domains.value = dom;
    pickProjects.value = pp;
    users.value = us;
  } finally {
    loading.value = false;
  }
}

// ---------- 项目盘点 ----------
const invDialog = ref(false);
const editingInv = ref<any>(null);
const invForm = reactive<any>({
  title: '',
  projectId: null,
  forms: [] as string[],
  websiteUrl: '',
  hasMiniProgram: false,
  miniProgramName: '',
  githubUrl: '',
  githubAccount: '',
  admin: '',
  ownerId: null,
  remark: '',
  serverIds: [] as string[],
  domainIds: [] as string[],
});

function resetInvForm() {
  Object.assign(invForm, {
    title: '', projectId: null, forms: [], websiteUrl: '', hasMiniProgram: false,
    miniProgramName: '', githubUrl: '', githubAccount: '', admin: '', ownerId: null, remark: '',
    serverIds: [], domainIds: [],
  });
}

function openInventory(row?: any) {
  editingInv.value = row || null;
  resetInvForm();
  if (row) {
    Object.assign(invForm, {
      title: row.title,
      projectId: row.projectId || null,
      forms: [...(row.forms || [])],
      websiteUrl: row.websiteUrl || '',
      hasMiniProgram: !!row.hasMiniProgram,
      miniProgramName: row.miniProgramName || '',
      githubUrl: row.githubUrl || '',
      githubAccount: row.githubAccount || '',
      admin: row.admin || '',
      ownerId: row.ownerId || null,
      remark: row.remark || '',
      serverIds: (row.servers || []).map((s: any) => s.serverId),
      domainIds: (row.domains || []).map((d: any) => d.domainId),
    });
  }
  invDialog.value = true;
}

// 选择已有项目时，若标题为空则自动带入项目名
function onPickProject(id: string) {
  if (!id) return;
  const p = pickProjects.value.find((x) => x.id === id);
  if (p && !invForm.title.trim()) invForm.title = p.name;
}

async function saveInventory() {
  if (!invForm.title.trim()) {
    ElMessage.warning('请填写项目/盘点名称');
    return;
  }
  if (invForm.githubUrl.trim() && !invForm.githubAccount.trim()) {
    ElMessage.warning('已填写 GitHub 链接，请再填写 GitHub 账号（组织/个人账号名）');
    return;
  }
  saving.value = true;
  try {
    if (editingInv.value) {
      await inventoryApi.update(editingInv.value.id, invForm);
      ElMessage.success('已保存');
    } else {
      await inventoryApi.create(invForm);
      ElMessage.success('盘点已新增');
    }
    invDialog.value = false;
    await loadAll();
  } finally {
    saving.value = false;
  }
}

async function delInventory(row: any) {
  await ElMessageBox.confirm(`确定删除盘点条目「${row.title}」？`, '删除', { type: 'warning' });
  await inventoryApi.remove(row.id);
  ElMessage.success('已删除');
  await loadAll();
}

// ---------- 服务器台账 ----------
const serverDialog = ref(false);
const editingServer = ref<any>(null);
const serverForm = reactive<any>({
  name: '', ip: '', label: '', provider: '腾讯云', region: '', spec: '', usage: '', expireAt: '', ownerId: null, remark: '',
});

function resetServerForm() {
  Object.assign(serverForm, {
    name: '', ip: '', label: '', provider: '腾讯云', region: '', spec: '', usage: '', expireAt: '', ownerId: null, remark: '',
  });
}

function openServer(row?: any) {
  editingServer.value = row || null;
  resetServerForm();
  if (row) {
    Object.assign(serverForm, {
      name: row.name || '',
      ip: row.ip,
      label: row.label || '',
      provider: row.provider || '腾讯云',
      region: row.region || '',
      spec: row.spec || '',
      usage: row.usage || '',
      expireAt: row.expireAt ? dayjs(row.expireAt).format('YYYY-MM-DD') : '',
      ownerId: row.ownerId || null,
      remark: row.remark || '',
    });
  }
  serverDialog.value = true;
}

async function saveServer() {
  if (!serverForm.ip.trim()) {
    ElMessage.warning('请填写服务器 IP');
    return;
  }
  if (!serverForm.provider.trim()) {
    ElMessage.warning('请填写云厂商/归属');
    return;
  }
  saving.value = true;
  try {
    if (editingServer.value) {
      await inventoryApi.updateServer(editingServer.value.id, serverForm);
      ElMessage.success('已保存');
    } else {
      await inventoryApi.createServer(serverForm);
      ElMessage.success('服务器已新增');
    }
    serverDialog.value = false;
    await loadAll();
  } finally {
    saving.value = false;
  }
}

async function delServer(row: any) {
  await ElMessageBox.confirm(`确定删除服务器「${row.name || row.ip}」？其对项目/域名的关联将一并解除。`, '删除服务器', { type: 'warning' });
  await inventoryApi.removeServer(row.id);
  ElMessage.success('已删除');
  await loadAll();
}

// ---------- 域名台账 ----------
const domainDialog = ref(false);
const editingDomain = ref<any>(null);
const domainForm = reactive<any>({
  domain: '', nature: 'ENTERPRISE', registrar: '', filing: '', expireAt: '', ownerId: null, remark: '', serverIds: [] as string[],
});

function resetDomainForm() {
  Object.assign(domainForm, {
    domain: '', nature: 'ENTERPRISE', registrar: '', filing: '', expireAt: '', ownerId: null, remark: '', serverIds: [],
  });
}

function openDomain(row?: any) {
  editingDomain.value = row || null;
  resetDomainForm();
  if (row) {
    Object.assign(domainForm, {
      domain: row.domain,
      nature: row.nature || 'ENTERPRISE',
      registrar: row.registrar || '',
      filing: row.filing || '',
      expireAt: row.expireAt ? dayjs(row.expireAt).format('YYYY-MM-DD') : '',
      ownerId: row.ownerId || null,
      remark: row.remark || '',
      serverIds: (row.servers || []).map((s: any) => s.serverId),
    });
  }
  domainDialog.value = true;
}

async function saveDomain() {
  if (!domainForm.domain.trim()) {
    ElMessage.warning('请填写域名');
    return;
  }
  saving.value = true;
  try {
    if (editingDomain.value) {
      await inventoryApi.updateDomain(editingDomain.value.id, domainForm);
      ElMessage.success('已保存');
    } else {
      await inventoryApi.createDomain(domainForm);
      ElMessage.success('域名已新增');
    }
    domainDialog.value = false;
    await loadAll();
  } finally {
    saving.value = false;
  }
}

async function delDomain(row: any) {
  await ElMessageBox.confirm(`确定删除域名「${row.domain}」？其对项目/服务器的关联将一并解除。`, '删除域名', { type: 'warning' });
  await inventoryApi.removeDomain(row.id);
  ElMessage.success('已删除');
  await loadAll();
}

onMounted(loadAll);
</script>

<style scoped>
/* ---------- 页头：标题 + 三个小统计 ---------- */
/* 页头横幅的底色/内边距/外边距由全局 styles.css 统一，这里只管内部排列 */
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.head-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat-row {
  display: flex;
  gap: 8px;
}
.stat {
  min-width: 78px;
  padding: 6px 12px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat-n {
  font-size: 17px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-k {
  font-size: var(--fs-2xs);
}

/* ---------- 工具条 ---------- */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.search {
  width: 320px;
  max-width: 60vw;
}

/* ---------- 卡片视图 ---------- */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.empty {
  grid-column: 1 / -1;
  padding: 40px 0;
  text-align: center;
  color: #8a94a6;
  background: #fff;
  border: 1px dashed #e4ebf5;
  border-radius: 12px;
}
.inv-card {
  background: #fff;
  border: 1px solid #e8eef8;
  border-radius: 14px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 1px 2px rgba(31, 45, 61, 0.03);
  transition: box-shadow 0.18s, transform 0.18s, border-color 0.18s;
}
.inv-card:hover {
  border-color: #cddcf7;
  box-shadow: 0 8px 22px rgba(47, 111, 224, 0.1);
  transform: translateY(-2px);
}
.card-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.card-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--app-ink);
  line-height: 1.4;
  word-break: break-all;
}
.card-forms {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: none;
  max-width: 55%;
}
.card-sub {
  font-size: 12px;
  color: #8a94a6;
}
.card-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.card-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  background: #fafcff;
  border: 1px solid #eef3fb;
  border-radius: 10px;
  padding: 8px 12px;
}
.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.meta-k {
  font-size: var(--fs-2xs);
  color: #8a94a6;
  white-space: nowrap;
}
.meta-v {
  font-size: 13px;
  color: #1f2d3d;
  font-weight: 600;
  word-break: break-all;
}
.meta-empty {
  color: #b6bfcd;
  font-weight: 400;
}
.card-rel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rel-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rel-k {
  font-size: var(--fs-2xs);
  color: #8a94a6;
  width: 36px;
  flex: none;
}
.card-remark {
  font-size: 12px;
  color: #5c6b80;
  background: #fffbf2;
  border: 1px solid #fdf0d5;
  border-radius: 8px;
  padding: 6px 10px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-ft {
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px dashed #eef2f8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ft-ops {
  display: flex;
}

/* ---------- 表格视图 ---------- */
.tbl {
  width: 100%;
}
.cell-strong {
  font-weight: 600;
}
.small {
  font-size: 12px;
}
.tag {
  margin: 0 4px 4px 0;
}
.link {
  color: #2f6fe0;
  text-decoration: none;
  word-break: break-all;
}
.link:hover {
  text-decoration: underline;
}
.remark-cell {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  color: #5c6b80;
}

/* ---------- 弹窗表单 ---------- */
.row {
  display: flex;
  gap: 12px;
}
.half {
  flex: 1;
  min-width: 0;
}
.form-tip {
  margin-top: 2px;
  line-height: 1.5;
}
.err-tip {
  margin-top: 2px;
  line-height: 1.5;
  font-size: 12px;
  color: var(--el-color-danger);
}
.inv-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--sp-3);
}
.scope-tip {
  margin-bottom: 12px;
}

/* ---------- 窄屏 ---------- */
@media (max-width: 640px) {
  .stat-row {
    width: 100%;
  }
  .stat {
    flex: 1;
  }
  .search {
    width: 100%;
    max-width: none;
  }
  .bar-left,
  .bar-right {
    width: 100%;
  }
  .cards {
    grid-template-columns: 1fr;
  }
  .row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
