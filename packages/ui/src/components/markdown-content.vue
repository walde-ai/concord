<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../infra/render-markdown";

const props = defineProps<{
  markdown: string;
}>();

const html = computed<string>(() => {
  if (props.markdown.length === 0) {
    return "";
  }
  return renderMarkdown(props.markdown);
});
</script>

<template>
  <div class="prose-concord" v-html="html"></div>
</template>

<style scoped>
.prose-concord :deep(h1),
.prose-concord :deep(h2),
.prose-concord :deep(h3) {
  font-weight: 600;
  margin-top: 0.75rem;
  margin-bottom: 0.25rem;
  color: var(--color-text, #1f2937);
}
.prose-concord :deep(h1) {
  font-size: 1.125rem;
}
.prose-concord :deep(h2) {
  font-size: 1rem;
}
.prose-concord :deep(h3) {
  font-size: 0.875rem;
}
.prose-concord :deep(p) {
  margin-top: 0.25rem;
  margin-bottom: 0.25rem;
}
.prose-concord :deep(ul),
.prose-concord :deep(ol) {
  margin-top: 0.25rem;
  margin-bottom: 0.25rem;
  padding-left: 1.25rem;
  list-style-position: outside;
}
.prose-concord :deep(ul) {
  list-style: disc;
}
.prose-concord :deep(ol) {
  list-style: decimal;
}
.prose-concord :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.1rem 0.25rem;
  border-radius: 0.25rem;
}
.prose-concord :deep(pre) {
  margin-top: 0.25rem;
  margin-bottom: 0.25rem;
  padding: 0.5rem;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 0.375rem;
  overflow-x: auto;
}
.prose-concord :deep(pre code) {
  background: transparent;
  padding: 0;
}
.prose-concord :deep(a) {
  color: var(--color-primary, #2563eb);
  text-decoration: underline;
}
.prose-concord :deep(blockquote) {
  border-left: 2px solid rgba(0, 0, 0, 0.15);
  padding-left: 0.5rem;
  color: inherit;
  opacity: 0.85;
}
</style>
