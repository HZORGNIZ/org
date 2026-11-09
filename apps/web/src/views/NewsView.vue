<template>
  <div class="page" :class="{ embedded }">
    <div class="page-title" :class="{ 'title-embedded': embedded }">
      <span v-if="!embedded">行业资讯</span>
      <el-button @click="showSources = true">
        <el-icon><Setting /></el-icon>&nbsp;资讯源管理
      </el-button>
    </div>

    <!-- 查看模式：全部 / 项目精选 / 我的兴趣 -->
    <div class="page-card mode-bar">
      <span class="mode-label">查看模式</span>
      <el-select v-model="viewMode" class="mode-select" @change="onViewChange">
        <el-option value="all" label="全部资讯" />
        <el-option
          v-for="p in ruleProjects"
          :key="'project:' + p.id"
          :value="'project:' + p.id"
          :label="'项目精选 · ' + p.ownerName + ' · ' + p.name"
        />
        <el-option value="interest" label="我的兴趣精选" />
      </el-select>
      <span class="muted mode-tip">精选模式按规则用 AI 从团队资讯中筛选（近 7 天）</span>
      <div class="mode-actions">
        <el-dropdown v-if="ownedProjects.length" @command="openProjectRuleDialog">
          <el-button size="small">
            <el-icon><EditPen /></el-icon>&nbsp;项目展示规则
            <el-icon><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="p in ownedProjects"
                :key="p.id"
                :command="p.id"
              >
                {{ p.name }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button size="small" @click="openMyInterestDialog">
          <el-icon><Star /></el-icon>&nbsp;我的兴趣设定
        </el-button>
      </div>
    </div>

    <!-- 精选模式说明（当前生效规则） -->
    <div v-if="viewMode !== 'all'" class="page-card feed-banner">
      <el-tag type="warning" effect="dark" size="small">AI 精选</el-tag>
      <span class="feed-desc">{{ currentRuleText }}</span>
      <span v-if="!filteredBy" class="muted">（暂无有效规则，展示全部最近资讯；可在上方设定规则）</span>
    </div>

    <!-- 订阅源快捷切换（仅「全部」模式可用） -->
    <div v-if="viewMode === 'all' && sources.length" class="page-card src-bar">
      <el-check-tag :checked="!activeSourceId" @change="selectSource('')">全部</el-check-tag>
      <el-check-tag
        v-for="s in sources"
        :key="s.id"
        :checked="activeSourceId === s.id"
        @change="selectSource(s.id)"
      >
        {{ s.name }}
      </el-check-tag>
    </div>

    <!-- 资讯列表 -->
    <div class="page-card">
      <el-input
        v-model="keyword"
        placeholder="搜索资讯关键词…"
        clearable
        class="kw"
        :disabled="viewMode !== 'all'"
        @input="debounceLoad"
      />
      <div v-loading="loading" class="news-list">
        <div v-if="!items.length && !loading" class="muted empty">暂无资讯，请先在「资讯源管理」添加并抓取</div>
        <div v-for="n in items" :key="n.id" class="news-item" @click="openItem(n)">
          <div class="news-tags">
            <el-tooltip v-if="filteredBy === 'ai' && n.matchReason" :content="n.matchReason" placement="top">
              <el-tag type="warning" size="small" effect="plain">AI 精选</el-tag>
            </el-tooltip>
            <el-tag v-if="n.category" size="small" type="primary" effect="plain">{{ n.category }}</el-tag>
            <el-tag v-for="t in n.tags || []" :key="t" size="small" type="info" effect="plain">{{ t }}</el-tag>
          </div>
          <div class="news-title">{{ n.title }}</div>
          <div v-if="n.summary" class="news-summary ellipsis-2">{{ n.summary }}</div>
          <div class="news-meta muted">
            <span>{{ n.source?.name }}</span>
            <span>{{ timeAgo(n.publishedAt || n.createdAt) }}</span>
            <span v-if="n.readCount">阅读 {{ n.readCount }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 资讯详情 -->
    <el-drawer v-model="detailVisible" :title="current?.title" size="min(94vw, 640px)">
      <template v-if="current">
        <div class="news-meta muted">
          {{ current.source?.name }} · {{ fmt(current.publishedAt || current.createdAt) }}
          <a v-if="current.url" :href="current.url" target="_blank" rel="noopener" class="origin">查看原文 →</a>
        </div>
        <div class="news-content">{{ current.content || current.summary || '（无内容）' }}</div>
      </template>
    </el-drawer>

    <!-- 资讯源管理 -->
    <el-drawer v-model="showSources" title="资讯源管理" size="min(94vw, 480px)">
      <div class="src-add">
        <el-button type="primary" @click="openSourceForm(null)">+ 添加资讯源</el-button>
      </div>
      <div v-for="s in sources" :key="s.id" class="src-row">
        <div class="src-info">
          <b>{{ s.name }}</b>
          <span class="muted ellipsis">{{ s.url }}</span>
          <span class="muted">{{ s.type }}<template v-if="s.fetchIntervalMin"> · 每 {{ s.fetchIntervalMin }} 分钟抓取</template></span>
        </div>
        <div class="src-actions">
          <el-tag :type="s.enabled ? 'success' : 'info'" size="small">{{ s.enabled ? '启用' : '停用' }}</el-tag>
          <el-button size="small" text type="primary" :loading="fetchingId === s.id" @click="fetchNow(s)">抓取</el-button>
          <el-dropdown trigger="click" @command="(c: string) => srcCommand(c, s)">
            <el-button size="small" text>···</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="subscribe">{{ isSubscribed(s) ? '取消订阅' : '订阅' }}</el-dropdown-item>
                <el-dropdown-item command="edit">编辑</el-dropdown-item>
                <el-dropdown-item command="toggle">{{ s.enabled ? '停用' : '启用' }}</el-dropdown-item>
                <el-dropdown-item command="remove" divided>删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
      <div v-if="!sources.length" class="muted empty">暂无资讯源</div>
    </el-drawer>

    <!-- 资讯源表单 -->
    <el-dialog v-model="sourceFormVisible" :title="editingSource ? '编辑资讯源' : '添加资讯源'" width="min(92vw, 460px)">
      <el-form label-position="top">
        <el-form-item label="名称" required>
          <el-input v-model="sourceForm.name" placeholder="如：36氪" />
        </el-form-item>
        <el-form-item label="链接" required>
          <el-input v-model="sourceForm.url" placeholder="RSS / Atom 或资讯页 URL" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="sourceForm.type" style="width: 100%">
            <el-option label="RSS" value="RSS" />
            <el-option label="ATOM" value="ATOM" />
            <el-option label="HTML" value="HTML" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="sourceForm.category" placeholder="如：AI / 行业动态" />
        </el-form-item>
        <el-form-item label="抓取间隔（分钟）">
          <el-input-number v-model="sourceForm.fetchIntervalMin" :min="10" :max="1440" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sourceFormVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSource" @click="saveSource">保存</el-button>
      </template>
    </el-dialog>

    <!-- 展示规则 / 兴趣 编辑 -->
    <el-dialog
      v-model="ruleDialogVisible"
      :title="ruleDialogType === 'project' ? `项目展示规则 · ${ruleDialogProject?.name || ''}` : '我的资讯兴趣'"
      width="min(94vw, 520px)"
    >
      <div v-if="ruleDialogType === 'project'" class="rule-tip">
        设定后，AI 将按这段话从团队资讯中精选展示给该项目组成员（每位成员在资讯页可选择「项目精选」模式查看）。留空保存即清除规则。
      </div>
      <div v-else class="rule-tip">
        描述你感兴趣的方向，AI 将按这段话从团队资讯中为你精选；留空保存即清除（不使用个人精选）。
      </div>
      <el-input
        v-model="ruleText"
        type="textarea"
        :rows="4"
        :placeholder="ruleDialogType === 'project'
          ? '如：关注 AI 与制造业结合、质量管理方向，以及行业重大政策变化…'
          : '如：大模型应用、工业互联网、项目管理方法论…'"
      />
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingRule" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { newsApi, projectsApi } from '../api';
import { useAuthStore } from '../stores/auth';
import { fmt, timeAgo } from '../utils/format';
/** 内嵌于「资料中心」大 tab 时：隐藏自身页头标题、降格为紧凑工具条 */
defineProps<{ embedded?: boolean }>();

const auth = useAuthStore();
const items = ref<any[]>([]);
const sources = ref<any[]>([]);
const loading = ref(false);
const keyword = ref('');
const activeSourceId = ref('');
const fetchingId = ref('');

// ---- 查看模式 / 精选 ----
const viewMode = ref('all'); // all | project:<id> | interest
const filteredBy = ref<'ai' | null>(null);
const ruleProjects = ref<any[]>([]); // 我参与且已设规则的项目
const ownedProjects = ref<any[]>([]); // 我负责的项目（可设定规则）
const interestText = ref('');

const currentRuleText = computed(() => {
  if (viewMode.value.startsWith('project:')) {
    return ruleProjects.value.find((p) => 'project:' + p.id === viewMode.value)?.guideText || '';
  }
  if (viewMode.value === 'interest') return interestText.value;
  return '';
});

const detailVisible = ref(false);
const current = ref<any>(null);
const showSources = ref(false);

const sourceFormVisible = ref(false);
const editingSource = ref<any>(null);
const savingSource = ref(false);
const sourceForm = reactive({
  name: '',
  url: '',
  type: 'RSS',
  category: '',
  fetchIntervalMin: 60,
});

// ---- 规则弹窗 ----
const ruleDialogVisible = ref(false);
const ruleDialogType = ref<'project' | 'me'>('project');
const ruleDialogProject = ref<any>(null);
const ruleText = ref('');
const savingRule = ref(false);

let timer: any = null;
function debounceLoad() {
  clearTimeout(timer);
  timer = setTimeout(loadItems, 300);
}

function selectSource(id: string) {
  activeSourceId.value = id;
  loadItems();
}

/** 切换查看模式：清搜索与源筛选，feed 模式走 AI 精选接口 */
function onViewChange() {
  keyword.value = '';
  activeSourceId.value = '';
  loadItems();
}

async function loadItems() {
  loading.value = true;
  try {
    if (viewMode.value === 'all') {
      filteredBy.value = null;
      const params: any = {};
      if (keyword.value.trim()) params.keyword = keyword.value.trim();
      if (activeSourceId.value) params.sourceId = activeSourceId.value;
      // 接口返回 {items, allTags}（拦截器已解包 data），需取 items
      const res: any = await newsApi.items(params);
      items.value = res?.items || [];
    } else {
      const res: any = await newsApi.feed({ view: viewMode.value });
      filteredBy.value = res?.filteredBy || null;
      items.value = res?.items || [];
      if (res?.filteredBy !== 'ai' && viewMode.value === 'interest' && !interestText.value) {
        ElMessage.info('尚未设置兴趣方向，当前展示最近资讯；可点「我的兴趣设定」描述关注方向');
      }
    }
  } finally {
    loading.value = false;
  }
}

async function loadSources() {
  sources.value = await newsApi.sources();
}

/** 我参与且设了规则的项目 / 我负责的项目 / 我的兴趣文本 */
async function loadRules() {
  try {
    const my = await projectsApi.list();
    const owned: any[] = [];
    const withRule: any[] = [];
    await Promise.all(
      my.map(async (p: any) => {
        if (p.owner?.id === auth.user?.id) owned.push({ ...p, ownerName: p.owner?.name });
        try {
          const r: any = await newsApi.projectRule(p.id);
          if (r?.guideText) withRule.push({ ...p, guideText: r.guideText, ownerName: p.owner?.name });
        } catch {
          /* 不可读的项目规则忽略 */
        }
      }),
    );
    ownedProjects.value = owned;
    ruleProjects.value = withRule;
    const pref: any = await newsApi.myInterest();
    interestText.value = pref?.interestText || '';
  } catch {
    /* 拦截器已提示 */
  }
}

function openItem(n: any) {
  current.value = n;
  detailVisible.value = true;
}

function isSubscribed(s: any) {
  return (s.subscribers || []).some((u: any) => u.id === auth.user?.id || u.userId === auth.user?.id);
}

async function fetchNow(s: any) {
  fetchingId.value = s.id;
  try {
    const res: any = await newsApi.fetchNow(s.id);
    ElMessage.success(`抓取完成：新增 ${res.created || 0} 条`);
    loadItems();
  } finally {
    fetchingId.value = '';
  }
}

function srcCommand(cmd: string, s: any) {
  if (cmd === 'subscribe') {
    if (isSubscribed(s)) {
      newsApi.unsubscribe(s.id).then(() => {
        ElMessage.success('已取消订阅');
        loadSources();
      });
    } else {
      newsApi.subscribe(s.id).then(() => {
        ElMessage.success('已订阅，新资讯会推送到通知');
        loadSources();
      });
    }
  } else if (cmd === 'edit') {
    editingSource.value = s;
    Object.assign(sourceForm, {
      name: s.name,
      url: s.url,
      type: s.type || 'RSS',
      category: s.category || '',
      fetchIntervalMin: s.fetchIntervalMin || 60,
    });
    sourceFormVisible.value = true;
  } else if (cmd === 'toggle') {
    newsApi.updateSource(s.id, { enabled: !s.enabled }).then(loadSources);
  } else if (cmd === 'remove') {
    ElMessageBox.confirm(`确定删除资讯源「${s.name}」？`, '删除资讯源', { type: 'warning' }).then(() =>
      newsApi.removeSource(s.id).then(() => {
        ElMessage.success('已删除');
        loadSources();
        loadItems();
      }),
    );
  }
}

function openSourceForm(s: any | null) {
  editingSource.value = s;
  Object.assign(sourceForm, {
    name: s?.name || '',
    url: s?.url || '',
    type: s?.type || 'RSS',
    category: s?.category || '',
    fetchIntervalMin: s?.fetchIntervalMin || 60,
  });
  sourceFormVisible.value = true;
}

async function saveSource() {
  if (!sourceForm.name.trim() || !sourceForm.url.trim()) {
    ElMessage.warning('请填写名称和链接');
    return;
  }
  savingSource.value = true;
  try {
    if (editingSource.value) {
      await newsApi.updateSource(editingSource.value.id, sourceForm);
      ElMessage.success('已保存');
    } else {
      await newsApi.createSource(sourceForm);
      ElMessage.success('资讯源已添加');
    }
    sourceFormVisible.value = false;
    loadSources();
  } finally {
    savingSource.value = false;
  }
}

/** 打开我负责的某项目的规则编辑 */
function openProjectRuleDialog(projectId: string) {
  const p = ownedProjects.value.find((x) => x.id === projectId);
  if (!p) return;
  ruleDialogType.value = 'project';
  ruleDialogProject.value = p;
  ruleText.value = p.guideText || '';
  ruleDialogVisible.value = true;
}

/** 打开个人兴趣编辑 */
function openMyInterestDialog() {
  ruleDialogType.value = 'me';
  ruleDialogProject.value = null;
  ruleText.value = interestText.value;
  ruleDialogVisible.value = true;
}

async function saveRule() {
  savingRule.value = true;
  try {
    if (ruleDialogType.value === 'project') {
      await newsApi.saveProjectRule(ruleDialogProject.value.id, ruleText.value.trim());
      ElMessage.success('项目展示规则已保存');
    } else {
      await newsApi.saveMyInterest(ruleText.value.trim());
      ElMessage.success('兴趣设定已保存');
    }
    ruleDialogVisible.value = false;
    await loadRules();
    // 正在看该精选模式则刷新
    if (viewMode.value !== 'all') loadItems();
  } finally {
    savingRule.value = false;
  }
}

onMounted(() => {
  loadItems();
  loadSources();
  loadRules();
});
</script>

<style scoped>
.mode-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mode-label {
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.mode-select {
  width: 240px;
  flex-shrink: 0;
}
.mode-tip {
  font-size: 12px;
  flex: 1;
  min-width: 140px;
}
.mode-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.feed-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: #fdf6ec;
}
.feed-desc {
  font-size: 13px;
  color: #606266;
  line-height: 1.5;
}
.rule-tip {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
  margin-bottom: 10px;
  background: #f8fafc;
  border-radius: 6px;
  padding: 8px 10px;
}
.src-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.kw {
  margin-bottom: 10px;
}
.news-list {
  min-height: 100px;
}
.news-item {
  padding: 12px 4px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;
}
.news-item:last-child {
  border-bottom: none;
}
.news-item:hover {
  background: #f8fafc;
}
.news-tags {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.news-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
  line-height: 1.4;
}
.news-summary {
  font-size: 13px;
  color: #606266;
  margin-bottom: 6px;
}
.ellipsis-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.news-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
}
.news-content {
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}
.origin {
  float: right;
}
.src-add {
  margin-bottom: 12px;
}
.src-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f5f7fa;
}
.src-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.src-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.empty {
  text-align: center;
  padding: 20px 0;
}
</style>
