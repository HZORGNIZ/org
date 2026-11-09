<template>
  <div class="rp-doc">
    <section v-for="g in days" :key="g.key" class="rp-day">
      <div class="rp-rail">
        <div class="rp-date">{{ g.label }}</div>
        <div v-if="g.sub" class="muted rp-sub">{{ g.sub }}</div>
      </div>
      <div class="rp-body">
        <template v-for="(e, i) in g.entries" :key="e.key ?? `e${i}`">
          <!-- 分组标题（如部门）：与上一条同名时不重复出 -->
          <div v-if="e.dept && e.dept !== prevDept(g.entries, i)" class="rp-group">{{ e.dept }}</div>
          <article class="rp-entry" :class="entryClass(e)" @click="onOpen(e)">
            <div class="rp-head">
              <span class="rp-who">{{ e.name }}</span>
              <el-tag v-for="t in e.tags || []" :key="t.label" size="small" :type="t.type || 'info'" effect="plain">
                {{ t.label }}
              </el-tag>
              <span v-if="e.submitted === false" class="rp-miss">未提交</span>
              <span v-if="e.meta" class="muted rp-meta">{{ e.meta }}</span>
              <slot name="actions" :entry="e" />
            </div>
            <div v-if="e.content || bodyFallback" class="rp-text">{{ e.content || bodyFallback }}</div>
          </article>
        </template>
      </div>
    </section>
    <div v-if="!hasEntries" class="muted empty">{{ emptyText }}</div>
    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
// 日报「文档式时间轴」：左侧日期节点、右侧当天各成员正文，像在线文档一样按天往下读。
// 三处共用同一形态与同一套 .rp-* 全局样式（styles.css）：
//   1) 工作管理的历史日报（可点开详情）
//   2) 工作管理 → 日报看板（按日看全员，按部门分组）
//   3) 项目详情页的项目日报（按日看全员 / 按人看时间轴）
// 标签内容（工时、归属项目、状态…）由调用方拼好塞进 tags，组件只负责排版。
import { computed } from 'vue';
import type { DocDay, DocEntry } from './report-doc';

const props = withDefaults(
  defineProps<{
    days: DocDay[];
    /** 条目是否可点（调用方有详情可开时才给 true） */
    clickable?: boolean;
    /** 正文是否截断成 6 行（没有详情可开时必须给 false，否则正文看不全） */
    clamp?: boolean;
    emptyText?: string;
    /** 正文为空时的占位文字，默认不显示占位 */
    bodyFallback?: string;
  }>(),
  { clickable: true, clamp: true, emptyText: '暂无日报记录', bodyFallback: '' },
);

const emit = defineEmits<{ (e: 'open', entry: DocEntry): void }>();

const hasEntries = computed(() => props.days.some((g) => g.entries.length));

function prevDept(list: DocEntry[], i: number) {
  return i > 0 ? list[i - 1]?.dept : null;
}

function entryClass(e: DocEntry) {
  return {
    'is-missing': e.submitted === false,
    'is-plain': !props.clickable,
    'is-full': !props.clamp,
  };
}

function onOpen(e: DocEntry) {
  if (!props.clickable) return;
  emit('open', e);
}
</script>
