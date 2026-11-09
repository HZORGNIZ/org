import { ref } from 'vue';

/**
 * 通用「把 A 拖到 B 上松手」交互（桌面 HTML5 drag & drop + 移动端长按拖拽）
 * - 桌面端：源元素绑 draggable / onDragStart / onDragEnd，目标元素绑 onDragOver / onDrop
 * - 移动端：HTML5 DnD 不生效，改为长按 350ms 进入拖拽，手指下方按 data-drop-key 命中目标
 * - 松手后浏览器还会补一次 click，用 consumeClick() 抑制，避免误触发源元素自己的点击行为
 */

/** 触摸长按进入拖拽的时长（毫秒） */
const LONG_PRESS_MS = 350;
/** 未进入拖拽时判定为页面滚动的位移阈值（像素） */
const SCROLL_THRESHOLD_PX = 10;
/** 拖拽结束后抑制余波点击的时长（毫秒） */
const CLICK_SUPPRESS_MS = 400;

export const isTouchDevice =
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;

export function useDragTo<S>(options: {
  /** 源的稳定标识（同时用于 data-drop-key 命中判定） */
  keyOf: (source: S) => string;
  /** 源是否允许被拖动（返回 false 时点击照旧、拖拽不生效） */
  canDrag?: (source: S) => boolean;
  /** 松手命中目标：targetKey 取自目标元素上的 data-drop-key */
  onDropTarget: (source: S, targetKey: string) => void | Promise<void>;
}) {
  /** 当前拖拽中的源 key（空 = 未拖拽） */
  const dragKey = ref('');
  /** 当前悬停命中的目标 key（高亮用） */
  const overKey = ref('');
  const dragging = ref(false);

  let current: S | null = null;
  let suppressClick = false;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;

  const allowed = (source: S) => (options.canDrag ? options.canDrag(source) : true);
  const isSource = (key: string) => !!dragKey.value && dragKey.value === key;
  const isOver = (key: string) => !!overKey.value && overKey.value === key;

  /** 拖拽后的一次点击应被忽略（返回 true 时调用方中断点击处理） */
  function consumeClick(): boolean {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  function reset() {
    clearTimeout(pressTimer);
    current = null;
    dragging.value = false;
    dragKey.value = '';
    overKey.value = '';
  }

  /** 松手后短暂屏蔽点击：拖拽与长按都会在部分浏览器补发一次 click */
  function swallowClick() {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), CLICK_SUPPRESS_MS);
  }

  // ---- 桌面端：HTML5 drag & drop ----
  function onDragStart(e: DragEvent, source: S) {
    const key = options.keyOf(source);
    if (!allowed(source)) {
      e.preventDefault();
      return;
    }
    current = source;
    dragging.value = true;
    dragKey.value = key;
    overKey.value = '';
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key);
    }
  }

  function onDragOver(e: DragEvent, targetKey: string) {
    if (!dragging.value || !current) return;
    e.preventDefault(); // 允许投放
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (overKey.value !== targetKey) overKey.value = targetKey;
  }

  function onDragLeave(targetKey: string) {
    if (overKey.value === targetKey) overKey.value = '';
  }

  function onDrop(e: DragEvent, targetKey: string) {
    e.preventDefault();
    const source = current;
    reset();
    if (!source || !targetKey) return;
    swallowClick();
    void options.onDropTarget(source, targetKey);
  }

  function onDragEnd() {
    reset();
  }

  // ---- 移动端：长按进入拖拽，手指下方按 data-drop-key 命中 ----
  function onTouchStart(e: TouchEvent, source: S) {
    if (e.touches.length !== 1 || !allowed(source)) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      current = source;
      dragging.value = true;
      dragKey.value = options.keyOf(source);
      overKey.value = '';
      // 轻震动提示已进入拖拽（不支持则忽略）
      (navigator as any)?.vibrate?.(15);
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e: TouchEvent) {
    if (!dragging.value) {
      // 未进入拖拽：位移超过阈值视为页面滚动，取消长按
      const t = e.touches[0];
      if (t && Math.hypot(t.clientX - startX, t.clientY - startY) > SCROLL_THRESHOLD_PX) {
        clearTimeout(pressTimer);
      }
      return;
    }
    e.preventDefault(); // 拖拽中禁止页面滚动
    const t = e.touches[0];
    overKey.value = t ? hitKey(t.clientX, t.clientY) : '';
  }

  function onTouchEnd() {
    if (!dragging.value) {
      reset();
      return;
    }
    const source = current;
    const targetKey = overKey.value;
    reset();
    if (!source) return;
    swallowClick();
    if (targetKey) void options.onDropTarget(source, targetKey);
  }

  function hitKey(x: number, y: number): string {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest('[data-drop-key]') as HTMLElement | null)?.dataset?.dropKey ?? '';
  }

  return {
    dragKey,
    overKey,
    dragging,
    isSource,
    isOver,
    consumeClick,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: onTouchEnd,
  };
}
