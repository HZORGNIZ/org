<template>
  <div
    class="dspace"
    @dragenter.prevent="dragEnter"
    @dragover.prevent="dragEnter"
    @dragleave.prevent="dragLeave"
    @drop.prevent="onDrop"
  >
    <!-- 工具条：面包屑 + 搜索 + 上传设置 + 操作 -->
    <div class="ds-bar">
      <div class="ds-crumb">
        <el-button text size="small" :class="{ 'ds-crumb-on': !folderId && !keyword }" @click="goFolder(null)">
          {{ space?.spaceName || '文档空间' }}
        </el-button>
        <template v-for="(c, i) in crumbs" :key="c.id">
          <span class="ds-sep">/</span>
          <el-button
            text
            size="small"
            :class="{ 'ds-crumb-on': i === crumbs.length - 1 }"
            @click="goFolder(c.id)"
          >
            {{ c.name }}
          </el-button>
        </template>
      </div>
      <div class="ds-tools">
        <el-input
          v-model="keyword"
          size="small"
          placeholder="搜索文件名/类型/备注"
          clearable
          style="width: 140px"
          @keyup.enter="search"
          @clear="search"
        />
        <!-- 类型筛选：按文档类型跨文件夹收敛列表（找「所有技术方案」这类文档） -->
        <el-select
          v-model="filterDocType"
          size="small"
          placeholder="全部类型"
          clearable
          filterable
          style="width: 112px"
          title="按文档类型筛选（跨文件夹）"
          @change="load"
        >
          <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="visibility" size="small" style="width: 132px" :disabled="!!keyword">
          <el-option
            v-for="o in visOptions"
            :key="o.value"
            :label="o.label"
            :value="o.value"
          />
        </el-select>
        <!-- 上传类型：给本次上传的文件打类型，可直接输入自定义类型 -->
        <el-select
          v-model="uploadDocType"
          size="small"
          placeholder="上传类型"
          clearable
          filterable
          allow-create
          default-first-option
          :disabled="!!keyword"
          style="width: 118px"
          title="给本次上传的文件打类型（可输入自定义类型）"
        >
          <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
        </el-select>
        <el-input v-model="uploadNote" size="small" placeholder="备注（可选）" style="width: 100px" maxlength="200" />
        <el-button
          v-if="scope === 'project'"
          size="small"
          @click="copyShareLink"
        >
          复制外部访问链接
        </el-button>
        <el-button size="small" :disabled="!!keyword" @click="createFolder">新建文件夹</el-button>
        <el-button size="small" type="primary" :disabled="!!keyword" @click="pickFiles">
          <el-icon><Upload /></el-icon>&nbsp;上传文件
        </el-button>
      </div>
    </div>

    <div v-if="visibility === 'PUBLIC'" class="ds-hint">
      全员可见需管理员在「管理后台 → 文档审批」通过后才会对所有人生效；通过前仅你和管理员可见。
    </div>
    <div v-else-if="visibility === 'EXTERNAL'" class="ds-hint">
      对外部可见：上传时需设置访问密码与有效期（默认 3 天、最多 30 天），外部人员通过「复制外部访问链接」+ 密码即可查看/下载，到期后分享自动失效。
    </div>

    <!-- 拖拽遮罩 -->
    <div v-if="dragActive" class="ds-drop-mask">松开即可上传到{{ folderId ? '当前文件夹' : '根目录' }}</div>

    <!-- 上传进度 -->
    <div v-if="uploads.length" class="ds-uploads">
      <div v-for="(u, i) in uploads" :key="i" class="ds-upload-row">
        <span class="ellipsis ds-upload-name">{{ u.name }}</span>
        <el-progress :percentage="u.pct" :stroke-width="6" style="flex: 1" />
      </div>
    </div>

    <!-- 文件夹 -->
    <div v-if="folders.length && !keyword && !filterDocType" class="ds-folders">
      <div v-for="f in folders" :key="f.id" class="ds-folder" @click="goFolder(f.id)">
        <el-icon class="ds-folder-icon"><Folder /></el-icon>
        <span class="ellipsis ds-folder-name">{{ f.name }}</span>
        <span class="muted ds-folder-count">{{ f._count?.files ?? 0 }} 文件 · {{ f._count?.children ?? 0 }} 子夹</span>
        <el-dropdown trigger="click" size="small" @command="(c: string) => folderCommand(c, f)" @click.stop>
          <el-button text size="small" class="ds-folder-more" @click.stop>⋯</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="rename">重命名</el-dropdown-item>
              <el-dropdown-item command="delete" divided>删除文件夹</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 文件列表 -->
    <el-table :data="files" v-loading="loading" size="small" class="ds-table" empty-text="还没有文件，把文件拖到这里即可上传">
      <el-table-column label="名称" min-width="200">
        <template #default="{ row }">
          <div class="ds-name">
            <el-icon class="ds-name-icon"><Document /></el-icon>
            <span class="ellipsis" :title="row.name">{{ row.name }}</span>
            <el-tag v-if="row.version > 1" size="small" type="info" effect="plain">v{{ row.version }}</el-tag>
            <el-tag v-if="approvalTag(row.approval)" size="small" :type="approvalTag(row.approval)!.type" effect="plain">
              {{ approvalTag(row.approval)!.label }}
            </el-tag>
          </div>
          <div v-if="(keyword || filterDocType) && row.folder" class="muted ds-name-path">位于：{{ row.folder.name }}</div>
        </template>
      </el-table-column>
      <!-- 文档类型：有管理权时点标签直接改（下拉含预置+已用类型），更多菜单里可输入自定义类型 -->
      <el-table-column label="类型" width="116">
        <template #default="{ row }">
          <el-dropdown v-if="row.canManage" trigger="click" size="small" @command="(t: string) => setDocType(row, t)">
            <span class="ds-type-cell" :title="row.docType ? '点击修改文档类型' : '点击设置文档类型'">
              <el-tag size="small" effect="plain" :type="docTypeMeta(row.docType).color">{{ docTypeMeta(row.docType).label }}</el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="">未分类</el-dropdown-item>
                <el-dropdown-item v-for="t in typeOptions" :key="t" :command="t">
                  {{ t }}<span v-if="t === row.docType" class="ds-type-cur">✓</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tag v-else size="small" effect="plain" :type="docTypeMeta(row.docType).color">{{ docTypeMeta(row.docType).label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="92">
        <template #default="{ row }">{{ formatBytes(row.size) }}</template>
      </el-table-column>
      <el-table-column label="上传者" width="92">
        <template #default="{ row }">{{ row.uploader?.name || '—' }}</template>
      </el-table-column>
      <el-table-column label="上传时间" width="118">
        <template #default="{ row }">{{ fmtShort(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="备注" min-width="100">
        <template #default="{ row }">
          <span v-if="row.note" class="ds-note-txt" :title="row.note">{{ row.note }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="可见范围" width="92">
        <template #default="{ row }">
          <el-tag size="small" :type="visMeta(row.visibility).type" effect="plain">{{ visMeta(row.visibility).short }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="188" fixed="right">
        <template #default="{ row }">
          <el-button v-if="previewable(row)" size="small" text type="primary" @click="preview(row)">预览</el-button>
          <el-button size="small" text type="primary" @click="download(row)">下载</el-button>
          <el-button v-if="row.editable" size="small" text type="primary" @click="openEditor(row)">编辑</el-button>
          <el-dropdown trigger="click" size="small" @command="(c: string) => fileCommand(c, row)">
            <el-button text size="small">更多</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="versions">版本历史</el-dropdown-item>
                <el-dropdown-item command="rename">重命名</el-dropdown-item>
                <el-dropdown-item command="note">编辑备注</el-dropdown-item>
                <el-dropdown-item command="docType">设置文档类型</el-dropdown-item>
                <el-dropdown-item command="move">移动到文件夹</el-dropdown-item>
                <el-dropdown-item command="visibility">修改可见范围</el-dropdown-item>
                <el-dropdown-item v-if="row.canManage" command="delete" divided>删除文件</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>

    <input ref="fileInput" type="file" multiple hidden @change="onPicked" />

    <!-- 重名处理 -->
    <el-dialog v-model="conflict.visible" title="已有同名文件" width="min(94vw, 520px)">
      <div class="muted ds-conflict-tip">以下文件在当前文件夹中已存在，请为每个文件选择处理方式：</div>
      <div v-for="(c, i) in conflict.items" :key="i" class="ds-conflict-row">
        <div class="ds-conflict-main">
          <div class="ellipsis">{{ c.name }}</div>
          <div class="muted ds-conflict-old">
            现有：v{{ c.old.version }} · {{ formatBytes(c.old.size) }} · {{ c.old.uploader?.name }} · {{ fmtShort(c.old.updatedAt) }}
          </div>
        </div>
        <el-radio-group v-model="c.policy" size="small">
          <el-radio value="version">保留版本</el-radio>
          <el-radio value="overwrite">删除历史版本</el-radio>
          <el-radio value="rename">另存新名</el-radio>
        </el-radio-group>
      </div>
      <template #footer>
        <el-button @click="resolveConflict(false)">取消上传</el-button>
        <el-button @click="applyAll('version')">全部保留版本</el-button>
        <el-button type="primary" @click="resolveConflict(true)">开始上传</el-button>
      </template>
    </el-dialog>

    <!-- 文件属性编辑（重命名/备注/可见范围/移动） -->
    <el-dialog v-model="sheet.visible" :title="sheet.title" width="min(94vw, 460px)">
      <el-form label-position="top" size="small">
        <el-form-item v-if="sheet.kind === 'rename'" label="文件名称">
          <el-input v-model="sheet.name" maxlength="120" />
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'note'" label="备注">
          <el-input v-model="sheet.note" type="textarea" :rows="3" maxlength="200" placeholder="留空则清除备注" />
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'docType'" label="文档类型">
          <el-select
            v-model="sheet.docType"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="选择或输入类型"
            style="width: 100%"
          >
            <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
          </el-select>
          <div class="ds-hint" style="margin-top: 6px">
            预置：{{ DOC_TYPE_NAMES.join(' / ') }}。需要新类型时直接输入（不超过 {{ DOC_TYPE_MAX_LEN }} 个字），之后会出现在下拉里；留空表示未分类。
          </div>
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'visibility'" label="可见范围">
          <el-radio-group v-model="sheet.visibility">
            <el-radio v-for="o in visOptions" :key="o.value" :value="o.value" style="display: block; margin: 4px 0">
              {{ o.label }}
            </el-radio>
          </el-radio-group>
          <div v-if="sheet.visibility === 'PUBLIC' && sheet.oldVisibility !== 'PUBLIC'" class="ds-hint">
            改为全员可见后需管理员审批通过才生效。
          </div>
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'visibility' && sheet.visibility === 'EXTERNAL'" label="对外访问密码">
          <el-input
            v-model="sheet.externalPassword"
            type="password"
            show-password
            maxlength="40"
            :placeholder="sheet.oldVisibility === 'EXTERNAL' ? '留空则保持原密码不变，输入则更新' : '设置外部访问密码（至少 4 位）'"
          />
          <div class="ds-hint">
            外部人员通过分享链接 + 此密码查看/下载该文件。同密码的文件会一起展示。
          </div>
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'visibility' && sheet.visibility === 'EXTERNAL'" label="对外分享有效期（天，1-30）">
          <el-input
            v-model="sheet.externalValidDays"
            type="number"
            :min="1"
            :max="30"
            :placeholder="sheet.oldVisibility === 'EXTERNAL' ? '留空保持原到期时间，输入则从今起重设' : '默认 3 天，最多 30 天'"
          />
          <div class="ds-hint">
            <template v-if="sheet.oldVisibility === 'EXTERNAL' && sheet.externalExpiresAt">
              当前到期：{{ fmtShort(sheet.externalExpiresAt) }}。超过后外部访客无法再查看/下载。
            </template>
            <template v-else>超过有效期后，分享自动失效，外部访客无法再查看/下载（最多 30 天）。</template>
          </div>
        </el-form-item>
        <el-form-item v-if="sheet.kind === 'move'" label="目标文件夹">
          <el-select v-model="sheet.folderId" style="width: 100%" placeholder="根目录">
            <el-option label="根目录" value="" />
            <el-option v-for="f in folderChoices" :key="f.id" :label="f.path" :value="f.id" :disabled="f.id === sheet.folderSelf" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sheet.visible = false">取消</el-button>
        <el-button type="primary" :loading="sheet.saving" @click="saveSheet">保存</el-button>
      </template>
    </el-dialog>

    <!-- 版本历史 -->
    <el-dialog v-model="ver.visible" title="版本历史" width="min(94vw, 620px)">
      <div class="muted ds-ver-tip">
        {{ ver.name }}：当前 v{{ ver.current }}。保留版本上传的新文件会成为新版本，历史版本可随时下载。
      </div>
      <el-table :data="ver.versions" size="small" v-loading="ver.loading">
        <el-table-column label="版本" width="90">
          <template #default="{ row }">
            <span>v{{ row.version }}</span>
            <el-tag v-if="row.version === ver.current" size="small" type="success" effect="plain" class="ds-ver-cur">当前</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="90">
          <template #default="{ row }">{{ formatBytes(row.size) }}</template>
        </el-table-column>
        <el-table-column label="上传者" width="90">
          <template #default="{ row }">{{ row.uploader?.name || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="120">
          <template #default="{ row }">{{ fmtShort(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="downloadVersion(ver.id, row)">下载</el-button>
            <el-button
              v-if="ver.canManage && row.version !== ver.current"
              size="small"
              text
              type="danger"
              @click="deleteVersion(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- docx 在线编辑 -->
    <el-drawer v-model="editor.visible" :title="editor.name" size="min(96vw, 1000px)" destroy-on-close>
      <div class="ds-edit">
        <el-alert
          v-if="!editor.savedOnce"
          class="ds-edit-alert"
          type="info"
          :closable="true"
          show-icon
          title="轻量在线编辑"
          message="在线编辑会保留标题、正文、加粗/斜体/下划线、列表、表格、链接与图片；复杂排版（分栏、主题样式、SmartArt 等）可能丢失。保存将生成新版本，原版本仍可在「版本历史」中下载。"
        />
        <div v-if="editor.warnings.length" class="ds-edit-warn muted">
          读取原文档提示：{{ editor.warnings.slice(0, 3).map((w: any) => w.message || String(w)).join('；') }}
        </div>
        <div class="ds-edit-bar">
          <el-select v-model="editor.block" size="small" style="width: 96px" @change="applyBlock">
            <el-option label="正文" value="p" />
            <el-option label="标题 1" value="h1" />
            <el-option label="标题 2" value="h2" />
            <el-option label="标题 3" value="h3" />
          </el-select>
          <el-button size="small" @click="exec('bold')"><b>B</b></el-button>
          <el-button size="small" @click="exec('italic')"><i>I</i></el-button>
          <el-button size="small" @click="exec('underline')"><u>U</u></el-button>
          <el-button size="small" @click="exec('insertUnorderedList')">• 列表</el-button>
          <el-button size="small" @click="exec('insertOrderedList')">1. 列表</el-button>
          <el-button size="small" @click="applyBlock('blockquote')">引用</el-button>
          <el-button size="small" @click="linkPrompt()">链接</el-button>
          <el-button size="small" @click="editorImageInput?.click()">图片</el-button>
          <el-button size="small" @click="exec('justifyLeft')">左对齐</el-button>
          <el-button size="small" @click="exec('justifyCenter')">居中</el-button>
          <el-button size="small" @click="exec('removeFormat')">清除格式</el-button>
          <el-button size="small" @click="exec('undo')">撤销</el-button>
          <el-button size="small" @click="exec('redo')">重做</el-button>
        </div>
        <div
          ref="editorRef"
          class="ds-edit-body"
          :contenteditable="editor.canEdit ? 'true' : 'false'"
          :class="{ 'ds-edit-readonly': !editor.canEdit }"
        ></div>
        <input
          ref="editorImageRef"
          type="file"
          accept="image/*"
          hidden
          @change="onEditorImage"
        />
      </div>
      <template #footer>
        <span class="muted ds-edit-foot">{{ editor.meta }}</span>
        <el-button @click="editor.visible = false">关闭</el-button>
        <el-button v-if="editor.canEdit" type="primary" :loading="editor.saving" @click="saveEditor">保存为新版本</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { documentsApi, type DocConflictPolicy, type DocSpaceScope } from '../api';
import { FILE_APPROVAL, FILE_VIS, fmt, fmtShort, formatBytes } from '../utils/format';
import { DOC_TYPE_MAX_LEN, DOC_TYPE_NAMES, docTypeMeta, docTypeOptions } from '../utils/doc-types';

const props = defineProps<{ scope: DocSpaceScope; targetId: string }>();

const loading = ref(false);
const space = ref<any>(null);
const folders = ref<any[]>([]);
const files = ref<any[]>([]);
const crumbs = ref<{ id: string; name: string }[]>([]);
const folderId = ref<string | null>(null);
const keyword = ref('');
const dragActive = ref(false);

/** 新上传文件的默认可见范围与备注 */
const visibility = ref<string>('');
const uploadNote = ref('');
/** 上传时给文件打的类型（空 = 未分类）；filterDocType 是列表筛选条件，两者互不影响 */
const uploadDocType = ref('');
const filterDocType = ref('');

/** 类型下拉：预置词表 + 本空间已用过的自定义类型 */
const typeOptions = computed(() => docTypeOptions(files.value.map((f: any) => f.docType)));

const fileInput = ref<HTMLInputElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const editorImageRef = ref<HTMLInputElement | null>(null);
const editorImageInput = computed(() => editorImageRef.value);

const visOptions = computed(() => {
  const isProject = props.scope === 'project';
  const base = isProject ? 'PROJECT' : 'DEPARTMENT';
  const opts = [
    { value: base, label: FILE_VIS[base].label },
    { value: 'PRIVATE', label: FILE_VIS.PRIVATE.label },
  ];
  // 对外部可见仅项目空间提供（需项目生成分享链接）
  if (isProject) opts.push({ value: 'EXTERNAL', label: FILE_VIS.EXTERNAL.label });
  opts.push({ value: 'PUBLIC', label: `${FILE_VIS.PUBLIC.label}（需审批）` });
  return opts;
});

/** 复制本项目对外文档分享页链接（游客打开后输入密码访问） */
async function copyShareLink() {
  const url = `${location.origin}/share/${props.targetId}`;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('外部访问链接已复制，可发送给外部人员');
  } catch {
    await ElMessageBox.alert(url, '外部访问链接（手动复制）', { confirmButtonText: '好' }).catch(() => undefined);
  }
}

function visMeta(v: string) {
  return FILE_VIS[v] || { label: v, short: v, type: 'info' as const };
}
function approvalTag(a: string) {
  return FILE_APPROVAL[a];
}

watch(
  () => props.scope,
  () => {
    visibility.value = visOptions.value[0].value;
  },
  { immediate: true },
);

// ---------------- 加载 ----------------
async function load() {
  if (!props.targetId) return;
  loading.value = true;
  try {
    const data = await documentsApi.space({
      scope: props.scope,
      targetId: props.targetId,
      folderId: folderId.value,
      keyword: keyword.value,
      docType: filterDocType.value || undefined,
    });
    space.value = data;
    folders.value = data.folders || [];
    files.value = data.files || [];
    crumbs.value =
      keyword.value || filterDocType.value ? [] : folderId.value ? await documentsApi.breadcrumb(folderId.value) : [];
  } finally {
    loading.value = false;
  }
}

function goFolder(id: string | null) {
  folderId.value = id;
  keyword.value = '';
  // 进入文件夹是「正常浏览」动作，清掉类型筛选，避免列表与面包屑语义打架
  filterDocType.value = '';
  load();
}

function search() {
  if (keyword.value.trim()) folderId.value = null;
  load();
}

function pickFiles() {
  fileInput.value?.click();
}

function onPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const list = Array.from(input.files || []);
  input.value = '';
  enqueue(list);
}

// ---------------- 拖拽上传 ----------------
let dragDepth = 0;
function dragEnter() {
  dragDepth += 1;
  dragActive.value = true;
}
function dragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragActive.value = false;
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragActive.value = false;
  const list = Array.from(e.dataTransfer?.files || []);
  if (list.length) enqueue(list);
}

// ---------------- 上传（含重名处理） ----------------
const uploads = ref<{ name: string; pct: number }[]>([]);
const conflict = reactive({
  visible: false,
  items: [] as { name: string; old: any; policy: DocConflictPolicy }[],
  resolve: null as null | ((ok: boolean) => void),
});

function resolveConflict(ok: boolean) {
  conflict.visible = false;
  conflict.resolve?.(ok);
  conflict.resolve = null;
}

function applyAll(policy: DocConflictPolicy) {
  conflict.items.forEach((c) => {
    c.policy = policy;
  });
  resolveConflict(true);
}

/** 逐个探测重名 → 需要时统一征询处理方式 → 顺序上传 */
async function enqueue(list: File[]) {
  if (!list.length) return;
  if (keyword.value) {
    ElMessage.warning('搜索状态下不能上传，请先返回文件夹');
    return;
  }
  // 对外部可见：先统一收集访问密码与有效期天数（同批文件共用），取消则中断上传
  let extPwd = '';
  let extDays = 3;
  if (visibility.value === 'EXTERNAL') {
    const { value } = await ElMessageBox.prompt(
      '为对外可见文件设置访问密码（外部人员凭此密码查看/下载；同密码的文件会一起展示）',
      '对外访问密码',
      {
        inputType: 'password',
        inputValidator: (v: string) => (v && v.trim().length >= 4) || '密码至少 4 位',
        confirmButtonText: '继续',
      },
    ).catch(() => ({ value: null as unknown as string }));
    if (value === null || value === undefined) return;
    extPwd = (value || '').trim();
    const { value: dv } = await ElMessageBox.prompt(
      '设置对外分享有效期（天数 1-30，默认 3；到期后分享自动失效）',
      '对外访问有效期',
      {
        inputValue: '3',
        inputPattern: /^([1-9]|[12][0-9]|30)$/,
        inputErrorMessage: '需为 1-30 的整数天数',
        confirmButtonText: '继续',
      },
    ).catch(() => ({ value: null as unknown as string }));
    if (dv === null || dv === undefined) return;
    extDays = Number(dv);
  }
  const jobs: { file: File; policy: DocConflictPolicy }[] = [];
  const dups: { name: string; old: any; policy: DocConflictPolicy }[] = [];
  for (const file of list) {
    let hit: any = null;
    try {
      const res = await documentsApi.conflict({
        scope: props.scope,
        targetId: props.targetId,
        name: file.name,
        folderId: folderId.value,
      });
      hit = res.exists ? res.file : null;
    } catch {
      hit = null; // 探测失败按无重名处理，服务端仍会按 conflict 策略执行
    }
    if (hit) dups.push({ name: file.name, old: hit, policy: 'version' });
    jobs.push({ file, policy: 'version' });
  }
  if (dups.length) {
    conflict.items = dups;
    const ok = await new Promise<boolean>((resolve) => {
      conflict.resolve = resolve;
      conflict.visible = true;
    });
    if (!ok) {
      conflict.items = [];
      return;
    }
    for (const job of jobs) {
      const hit = dups.find((d) => d.name === job.file.name);
      if (hit) job.policy = hit.policy;
    }
    conflict.items = [];
  }
  let done = 0;
  for (const job of jobs) {
    if (await uploadOne(job.file, job.policy, extPwd, extDays)) done += 1;
  }
  if (done) {
    if (visibility.value === 'PUBLIC') {
      ElMessage.success(`已上传 ${done} 个文件，全员可见需管理员审批后生效`);
    } else {
      ElMessage.success(`已上传 ${done} 个文件`);
    }
    uploadNote.value = '';
    // 上传后回到「全部类型」，否则新文件若不在当前筛选类型里会像没上传成功
    filterDocType.value = '';
    await load();
  }
}

async function uploadOne(file: File, policy: DocConflictPolicy, extPwd = '', extDays = 3) {
  const row = reactive({ name: file.name, pct: 0 });
  uploads.value.push(row);
  try {
    await documentsApi.upload(
      file,
      {
        scope: props.scope,
        targetId: props.targetId,
        folderId: folderId.value,
        visibility: visibility.value,
        externalPassword: visibility.value === 'EXTERNAL' ? extPwd : undefined,
        externalValidDays: visibility.value === 'EXTERNAL' ? extDays : undefined,
        note: uploadNote.value.trim() || undefined,
        docType: uploadDocType.value.trim() || undefined,
        conflict: policy,
      },
      (pct) => {
        row.pct = pct;
      },
    );
    row.pct = 100;
    return true;
  } catch {
    return false;
  } finally {
    const idx = uploads.value.indexOf(row);
    if (idx >= 0) uploads.value.splice(idx, 1);
  }
}

// ---------------- 文件夹 ----------------
async function createFolder() {
  const { value } = await ElMessageBox.prompt('新建文件夹（当前目录下）', '文件夹名称', {
    inputPlaceholder: '如：设计稿 / 验收报告',
    confirmButtonText: '创建',
  }).catch(() => ({ value: '' }));
  const name = (value || '').trim();
  if (!name) return;
  await documentsApi.createFolder({
    scope: props.scope,
    targetId: props.targetId,
    name,
    parentId: folderId.value,
  });
  ElMessage.success('文件夹已创建');
  await load();
}

async function folderCommand(cmd: string, f: any) {
  if (cmd === 'rename') {
    const { value } = await ElMessageBox.prompt('重命名文件夹', '文件夹名称', {
      inputValue: f.name,
      confirmButtonText: '保存',
    }).catch(() => ({ value: '' }));
    const name = (value || '').trim();
    if (!name || name === f.name) return;
    await documentsApi.renameFolder(f.id, name);
    ElMessage.success('已重命名');
    await load();
  } else if (cmd === 'delete') {
    try {
      await ElMessageBox.confirm(`删除文件夹「${f.name}」？文件夹内有文件或子文件夹时无法删除。`, '删除文件夹', {
        type: 'warning',
        confirmButtonText: '删除',
      });
    } catch {
      return;
    }
    await documentsApi.deleteFolder(f.id);
    ElMessage.success('文件夹已删除');
    await load();
  }
}

// ---------------- 下载 / 预览 ----------------
const PREVIEW_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'txt', 'md', 'log', 'json', 'csv'];

function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function previewable(row: any) {
  return PREVIEW_EXT.includes(extOf(row.name || ''));
}

function mimeOf(name: string) {
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    txt: 'text/plain',
    md: 'text/plain',
    log: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
  };
  return map[extOf(name)] || 'application/octet-stream';
}

async function download(row: any) {
  const blob = await documentsApi.content(row.id);
  saveBlob(blob, row.name);
}

async function preview(row: any) {
  const blob = await documentsApi.content(row.id, { inline: true });
  const url = URL.createObjectURL(new Blob([blob], { type: mimeOf(row.name) }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------- 文件操作 ----------------
const sheet = reactive({
  visible: false,
  kind: 'rename' as 'rename' | 'note' | 'docType' | 'visibility' | 'move',
  title: '',
  id: '',
  name: '',
  note: '',
  docType: '',
  visibility: '',
  oldVisibility: '',
  externalPassword: '',
  externalValidDays: '',
  externalExpiresAt: '',
  folderId: '' as string,
  folderSelf: '' as string,
  saving: false,
});
const folderChoices = ref<{ id: string; path: string }[]>([]);

/** 逐层展开空间内文件夹（浅层优先，最多 30 次请求 / 3 层）供「移动到」选择 */
async function loadFolderChoices() {
  const out: { id: string; path: string }[] = [];
  const queue: { id: string | null; path: string; depth: number }[] = [{ id: null, path: '', depth: 0 }];
  let calls = 0;
  while (queue.length && calls < 30) {
    const cur = queue.shift()!;
    calls += 1;
    let data: any;
    try {
      data = await documentsApi.space({ scope: props.scope, targetId: props.targetId, folderId: cur.id });
    } catch {
      break;
    }
    for (const f of data.folders || []) {
      const path = cur.path ? `${cur.path}/${f.name}` : f.name;
      out.push({ id: f.id, path });
      if (cur.depth < 2) queue.push({ id: f.id, path, depth: cur.depth + 1 });
    }
  }
  folderChoices.value = out;
}

/** 行内改文档类型：只改该行数据，避免整表重新加载导致滚动位置跳动 */
async function setDocType(row: any, t: string) {
  const docType = String(t ?? '').trim();
  if ((row.docType || '') === docType) return;
  try {
    await documentsApi.patchFile(row.id, { docType: docType || null });
    row.docType = docType || null;
    ElMessage.success(docType ? `已设为「${docType}」` : '已设为未分类');
  } catch {
    // 失败提示由请求拦截器统一弹出，这里不再重复
  }
}

async function fileCommand(cmd: string, row: any) {  if (cmd === 'delete') {
    try {
      await ElMessageBox.confirm(
        `删除「${row.name}」？该文件的全部历史版本会一并删除，不可恢复。`,
        '删除文件',
        { type: 'warning', confirmButtonText: '删除' },
      );
    } catch {
      return;
    }
    await documentsApi.removeFile(row.id);
    ElMessage.success('文件已删除');
    await load();
    return;
  }
  if (cmd === 'versions') {
    ver.visible = true;
    ver.id = row.id;
    ver.name = row.name;
    ver.current = row.version;
    ver.canManage = !!row.canManage;
    ver.loading = true;
    try {
      const data = await documentsApi.versions(row.id);
      ver.versions = data.versions;
      ver.current = data.current;
      ver.canManage = data.canManage;
    } finally {
      ver.loading = false;
    }
    return;
  }
  sheet.kind = cmd as any;
  sheet.id = row.id;
  sheet.title =
    cmd === 'rename'
      ? '重命名文件'
      : cmd === 'note'
        ? '编辑备注'
        : cmd === 'docType'
          ? '设置文档类型'
          : cmd === 'visibility'
            ? '修改可见范围'
            : '移动到文件夹';
  sheet.name = row.name;
  sheet.note = row.note || '';
  sheet.docType = row.docType || '';
  sheet.visibility = row.visibility;
  sheet.oldVisibility = row.visibility;
  sheet.externalPassword = '';
  sheet.externalExpiresAt = row.externalExpiresAt || '';
  sheet.externalValidDays = row.visibility === 'EXTERNAL' ? '' : '3';
  sheet.folderId = row.folder?.id ?? (folderId.value ?? '');
  sheet.folderSelf = row.folder?.id ?? folderId.value ?? '';
  sheet.visible = true;
  if (cmd === 'move' && !folderChoices.value.length) {
    await loadFolderChoices();
  }
}

async function saveSheet() {
  sheet.saving = true;
  try {
    if (sheet.kind === 'rename') {
      const name = sheet.name.trim();
      if (!name) {
        ElMessage.warning('文件名不能为空');
        return;
      }
      await documentsApi.patchFile(sheet.id, { name });
    } else if (sheet.kind === 'note') {
      await documentsApi.patchFile(sheet.id, { note: sheet.note.trim() || null });
    } else if (sheet.kind === 'docType') {
      const docType = String(sheet.docType ?? '').trim();
      if (docType.length > DOC_TYPE_MAX_LEN) {
        ElMessage.warning(`文档类型不超过 ${DOC_TYPE_MAX_LEN} 个字`);
        return;
      }
      await documentsApi.patchFile(sheet.id, { docType: docType || null });
    } else if (sheet.kind === 'visibility') {
      const enteringExt = sheet.visibility === 'EXTERNAL' && sheet.oldVisibility !== 'EXTERNAL';
      if (enteringExt && sheet.externalPassword.trim().length < 4) {
        ElMessage.warning('设为对外部可见需设置至少 4 位访问密码');
        return;
      }
      let days: number | undefined;
      const daysStr = String(sheet.externalValidDays).trim();
      if (daysStr) {
        days = Number(daysStr);
        if (!Number.isInteger(days) || days < 1 || days > 30) {
          ElMessage.warning('对外分享有效期需为 1-30 的整数天');
          return;
        }
      } else if (enteringExt) {
        days = 3; // 首次进入默认 3 天
      }
      const payload: Parameters<typeof documentsApi.patchFile>[1] = { visibility: sheet.visibility };
      if (sheet.externalPassword.trim()) payload.externalPassword = sheet.externalPassword.trim();
      if (days !== undefined) payload.externalValidDays = days;
      await documentsApi.patchFile(sheet.id, payload);
    } else if (sheet.kind === 'move') {
      await documentsApi.patchFile(sheet.id, { folderId: sheet.folderId || null });
    }
    ElMessage.success(
      sheet.kind === 'visibility' && sheet.visibility === 'PUBLIC' && sheet.oldVisibility !== 'PUBLIC'
        ? '已提交，等待管理员审批'
        : sheet.kind === 'visibility' && sheet.visibility === 'EXTERNAL'
          ? '已设为对外部可见'
          : '已保存',
    );
    sheet.visible = false;
    await load();
  } finally {
    sheet.saving = false;
  }
}

// ---------------- 版本历史 ----------------
const ver = reactive({
  visible: false,
  loading: false,
  id: '',
  name: '',
  current: 1,
  canManage: false,
  versions: [] as any[],
});

async function downloadVersion(id: string, v: any) {
  const blob = await documentsApi.content(id, { version: v.version });
  const ext = extOf(ver.name) ? `.${extOf(ver.name)}` : '';
  saveBlob(blob, `${ver.name.replace(ext, '')}_v${v.version}${ext}`);
}

async function deleteVersion(v: any) {
  try {
    await ElMessageBox.confirm(`删除 v${v.version}？该历史版本不可恢复，当前版本不受影响。`, '删除历史版本', {
      type: 'warning',
      confirmButtonText: '删除',
    });
  } catch {
    return;
  }
  await documentsApi.removeVersion(ver.id, v.version);
  ElMessage.success('历史版本已删除');
  const data = await documentsApi.versions(ver.id);
  ver.versions = data.versions;
  ver.current = data.current;
  ver.canManage = data.canManage;
  await load();
}

// ---------------- docx 在线编辑 ----------------
const editor = reactive({
  visible: false,
  canEdit: false,
  saving: false,
  savedOnce: false,
  id: '',
  name: '',
  meta: '',
  block: 'p',
  warnings: [] as any[],
});

async function openEditor(row: any) {
  const data = await documentsApi.editable(row.id);
  editor.visible = true;
  editor.id = data.file.id;
  editor.name = data.file.name;
  editor.canEdit = data.canEdit;
  editor.warnings = data.warnings || [];
  editor.savedOnce = false;
  editor.block = 'p';
  editor.meta = `v${data.file.version} · ${formatBytes(data.file.size)} · 更新于 ${fmt(data.file.updatedAt, 'YYYY-MM-DD HH:mm')}${
    data.canEdit ? '' : ' · 你无权编辑，仅可查看'
  }`;
  await nextTick();
  if (editorRef.value) {
    editorRef.value.innerHTML = data.html || '';
  }
}

function exec(cmd: string, val?: string) {
  editorRef.value?.focus();
  document.execCommand(cmd, false, val);
}

function applyBlock(tag: string) {
  exec('formatBlock', `<${tag}>`);
}

async function linkPrompt() {
  const { value } = await ElMessageBox.prompt('链接地址（http/https）', '插入链接', {
    inputValue: 'https://',
    confirmButtonText: '插入',
  }).catch(() => ({ value: '' }));
  const url = (value || '').trim();
  if (!/^https?:\/\//i.test(url)) return;
  const sel = window.getSelection()?.toString();
  if (sel) exec('createLink', url);
  else exec('insertHTML', `<a href="${url}">${url}</a>`);
}

function onEditorImage(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('单张图片请控制在 8MB 以内');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    exec('insertHTML', `<img src="${String(reader.result)}" style="max-width:100%">`);
  };
  reader.readAsDataURL(file);
}

async function saveEditor() {
  const html = editorRef.value?.innerHTML || '';
  editor.saving = true;
  try {
    const res: any = await documentsApi.saveEditable(editor.id, html);
    editor.savedOnce = true;
    ElMessage.success(res?.version ? `已保存为 v${res.version}` : '已保存为新版本');
    editor.visible = false;
    await load();
  } finally {
    editor.saving = false;
  }
}

watch(
  () => props.targetId,
  () => {
    folderId.value = null;
    keyword.value = '';
    load();
  },
);

onMounted(() => {
  load();
});

defineExpose({ reload: load });
</script>

<style scoped>
.dspace {
  position: relative;
}
.ds-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.ds-crumb {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  min-width: 0;
}
.ds-crumb :deep(.el-button) {
  padding: 4px 6px;
  font-size: 13px;
}
.ds-crumb-on :deep(.el-button) {
  font-weight: 600;
}
.ds-sep {
  color: #c0c4cc;
  font-size: 12px;
}
.ds-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ds-hint {
  font-size: 12px;
  color: #e6a23c;
  background: #fdf6ec;
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
}
.ds-drop-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: var(--el-color-primary);
  background: rgba(66, 139, 255, 0.08);
  border: 2px dashed var(--el-color-primary);
  border-radius: 8px;
  pointer-events: none;
}
.ds-uploads {
  margin-bottom: 8px;
  padding: 6px 8px;
  background: #f8fafc;
  border-radius: 6px;
}
.ds-upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 2px 0;
}
.ds-upload-name {
  width: 160px;
  flex-shrink: 0;
}
.ds-folders {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.ds-folder {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  max-width: 320px;
}
.ds-folder:hover {
  border-color: var(--el-color-primary);
  background: #f8fafc;
}
.ds-folder-icon {
  color: #e6a23c;
}
.ds-folder-name {
  font-weight: 500;
  min-width: 0;
}
.ds-folder-count {
  font-size: 12px;
  white-space: nowrap;
}
.ds-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ds-name-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}
.ds-name-path {
  font-size: 12px;
  margin-top: 2px;
}
/* 类型标签：可点击改类型时给手势；行高收紧避免类型列把行撑高 */
.ds-type-cell {
  display: inline-block;
  cursor: pointer;
}
.ds-type-cell .el-tag,
.ds-table .el-tag {
  cursor: inherit;
}
.ds-type-cur {
  margin-left: 6px;
  color: var(--app-brand-ink, #409eff);
}
.ds-note-txt {
  font-size: 12px;
  color: #606266;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.ds-conflict-tip {
  margin-bottom: 8px;
  font-size: 12px;
}
.ds-conflict-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f5f7fa;
  flex-wrap: wrap;
}
.ds-conflict-main {
  min-width: 0;
  flex: 1;
  font-size: 13px;
}
.ds-conflict-old {
  font-size: 12px;
  margin-top: 2px;
}
.ds-ver-tip {
  font-size: 12px;
  margin-bottom: 8px;
}
.ds-ver-cur {
  margin-left: 4px;
}
.ds-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}
.ds-edit-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 6px;
  border-bottom: 1px solid #ebeef5;
}
.ds-edit-warn {
  font-size: 12px;
  color: #e6a23c;
}
.ds-edit-body {
  flex: 1;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 14px 16px;
  line-height: 1.7;
  font-size: 14px;
  background: #fff;
  outline: none;
  min-height: 320px;
}
.ds-edit-body:focus-within,
.ds-edit-body:focus {
  border-color: var(--el-color-primary);
}
.ds-edit-readonly {
  background: #fafafa;
  color: #606266;
}
.ds-edit-body :deep(img) {
  max-width: 100%;
}
.ds-edit-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
}
.ds-edit-body :deep(td),
.ds-edit-body :deep(th) {
  border: 1px solid #dcdfe6;
  padding: 4px 6px;
}
.ds-edit-body :deep(blockquote) {
  margin: 8px 0;
  padding-left: 10px;
  border-left: 3px solid #dcdfe6;
  color: #606266;
}
.ds-edit-foot {
  float: left;
  font-size: 12px;
  align-self: center;
}
</style>
