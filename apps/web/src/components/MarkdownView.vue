<template>
  <div class="markdown-body" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const props = defineProps<{ content: string }>();
const html = computed(() => md.render(props.content || ''));
</script>
