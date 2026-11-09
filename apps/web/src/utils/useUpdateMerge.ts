import { ElMessage, ElMessageBox } from 'element-plus';
import { ref } from 'vue';
import { projectsApi } from '../api';

/**
 * 「进展」拖拽合并交互（首页 / 项目列表 / 项目详情共用）
 * - 桌面端：把同一项目的某条进展拖到另一条上松手即弹确认合并（HTML5 drag & drop）
 * - 移动端：长按 450ms 进入拖拽，拖到目标进展高亮，松手弹确认合并
 * - 拖拽松手后的余波点击用 consumeClick 抑制（避免误开「从进展创建任务」弹窗）
 */

/** 触摸长按进入拖拽的时长（毫秒） */
const LONG_PRESS_MS = 450;
/** 未进入拖拽时判定为页面滚动的位移阈值（像素） */
const SCROLL_THRESHOLD_PX = 10;

/** 粗指针（触摸）设备：用长按拖拽替代 HTML5 DnD，避免与浏览器原生长按拖拽冲突 */
export const isTouchDevice =
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;

export function useUpdateMerge(options: {
  /** 按 id 查找进展对象（触摸拖拽命中目标时用；找不到返回空则忽略该目标） */
  getItem: (key: string) => any;
  /** 取进展所属项目 id（同项目才可合并；默认读 projectId / project.id） */
  projectIdOf?: (u: any) => string;
  /** 合并成功回调（视图据此刷新列表） */
  onMerged?: (sourceId: string, targetId: string) => void | Promise<void>;
}) {
  const projectIdOf =
    options.projectIdOf ?? ((u: any) => String(u?.projectId ?? u?.project?.id ?? ''));
  const keyOf = (u: any) => String(u?.id ?? '');

  /** 拖拽源进展（null 表示未在拖拽） */
  const dragSource = ref<any>(null);
  /** 当前悬停/命中的目标进展 id（高亮用） */
  const dragOverKey = ref('');
  /** 是否处于触摸拖拽中 */
  const touchDragging = ref(false);
  const merging = ref(false);
  /** 拖拽松手后的余波点击抑制标记 */
  let suppressClick = false;

  const isDragging = (u: any) => !!dragSource.value && keyOf(dragSource.value) === keyOf(u);
  const isDragOver = (u: any) => !!dragOverKey.value && dragOverKey.value === keyOf(u);

  /** 拖拽后的一次点击应被忽略（返回 true 时调用方中断点击处理） */
  function consumeClick(): boolean {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  /** 同项目校验：不同项目的进展不允许合并 */
  function sameProject(a: any, b: any): boolean {
    const pa = projectIdOf(a);
    return !!pa && pa === projectIdOf(b);
  }

  /** 弹窗文案用短摘要 */
  function previewText(u: any): string {
    const t = String(u?.content ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 30 ? `${t.slice(0, 30)}…` : t || '（空进展）';
  }

  /** 合并前弹确认框，确认后调后端合并（源并入目标并删除源） */
  async function tryMerge(source: any, target: any) {
    if (merging.value || !source || !target) return;
    try {
      await ElMessageBox.confirm(
        `将「${previewText(source)}」合并到「${previewText(target)}」？合并后源进展将被删除，内容与要点将并入目标进展。`,
        '合并进展',
        { type: 'warning', confirmButtonText: '合并', cancelButtonText: '取消' },
      );
    } catch {
      return; // 用户取消
    }
    merging.value = true;
    try {
      await projectsApi.mergeUpdates(String(source.id), String(target.id));
      ElMessage.success('进展已合并');
      await options.onMerged?.(String(source.id), String(target.id));
    } catch (e: any) {
      ElMessage.error(e?.response?.data?.message || '合并失败，请稍后重试');
    } finally {
      merging.value = false;
    }
  }

  // ---- 桌面端：HTML5 drag & drop ----
  function onDragStart(e: DragEvent, u: any) {
    dragSource.value = u;
    dragOverKey.value = '';
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', keyOf(u));
    }
  }

  function onDragOver(e: DragEvent, u: any) {
    const src = dragSource.value;
    if (!src || keyOf(src) === keyOf(u) || !sameProject(src, u)) return;
    e.preventDefault(); // 允许投放
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverKey.value = keyOf(u);
  }

  function onDragLeave(u: any) {
    if (dragOverKey.value === keyOf(u)) dragOverKey.value = '';
  }

  function onDrop(e: DragEvent, u: any) {
    e.preventDefault();
    const src = dragSource.value;
    dragOverKey.value = '';
    dragSource.value = null;
    if (src && keyOf(src) !== keyOf(u) && sameProject(src, u)) {
      suppressClick = true; // 拖拽松手在部分浏览器还会触发 click
      void tryMerge(src, u);
    }
  }

  function onDragEnd() {
    dragSource.value = null;
    dragOverKey.value = '';
  }

  // ---- 移动端：长按拖拽 ----
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;

  function onTouchStart(e: TouchEvent, u: any) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      touchDragging.value = true;
      dragSource.value = u;
      dragOverKey.value = '';
      // 轻震动提示已进入拖拽（部分浏览器不支持则忽略）
      (navigator as any)?.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e: TouchEvent) {
    const src = dragSource.value;
    if (!touchDragging.value) {
      // 未进入拖拽：位移超过阈值视为页面滚动，取消长按
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - startX, t.clientY - startY) > SCROLL_THRESHOLD_PX) {
        clearTimeout(pressTimer);
      }
      return;
    }
    e.preventDefault(); // 拖拽中禁止页面滚动
    if (!src) return;
    // 命中手指下方的进展条目（data-merge-key 由各视图渲染时标注）
    const t = e.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null;
    const key = (el?.closest('[data-merge-key]') as HTMLElement | null)?.dataset?.mergeKey ?? '';
    const target = key ? options.getItem(key) : null;
    if (target && key !== keyOf(src) && sameProject(src, target)) {
      dragOverKey.value = key;
    } else {
      dragOverKey.value = '';
    }
  }

  /** 结束/取消触摸拖拽：命中有效目标则走合并确认 */
  function finishTouch() {
    clearTimeout(pressTimer);
    if (!touchDragging.value) return;
    const src = dragSource.value;
    const key = dragOverKey.value;
    touchDragging.value = false;
    dragSource.value = null;
    dragOverKey.value = '';
    suppressClick = true; // 长按松手会触发 click，需抑制误开转换弹窗
    const target = key ? options.getItem(key) : null;
    if (src && target && key !== keyOf(src)) void tryMerge(src, target);
  }

  return {
    dragSource,
    dragOverKey,
    touchDragging,
    merging,
    keyOf,
    isDragging,
    isDragOver,
    consumeClick,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    onTouchStart,
    onTouchMove,
    onTouchEnd: finishTouch,
    onTouchCancel: finishTouch,
  };
}
