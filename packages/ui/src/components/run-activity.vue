<script setup lang="ts">
import { ref } from "vue";
import type { ActivityItem } from "../infra/run-activity-reducer";
import MarkdownContent from "./markdown-content.vue";

defineProps<{
  items: ActivityItem[];
}>();

const expandedReasoning = ref<Set<string>>(new Set());

function toggleReasoning(key: string): void {
  const next = new Set(expandedReasoning.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedReasoning.value = next;
}

function formatTime(at: string): string {
  const date = new Date(at);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return date.toLocaleTimeString(undefined, { hour12: false }) + "." + ms;
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="item in items"
      :key="item.key"
    >
      <!-- Assistant text bubble -->
      <div v-if="item.itemType === 'text'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <div class="flex-1 rounded-lg bg-primary/5 px-3 py-2 text-sm text-text whitespace-pre-wrap">{{ item.text }}</div>
      </div>

      <!-- Tool card -->
      <div v-else-if="item.itemType === 'tool'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <div class="flex-1 rounded-lg border border-border bg-surface px-3 py-2">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-medium text-text">{{ item.toolName }}</span>
            <span
              class="rounded px-1.5 py-0.5 text-xs font-medium"
              :class="{
                'bg-yellow-100 text-yellow-800': item.status === 'pending',
                'bg-blue-100 text-blue-800': item.status === 'running',
                'bg-green-100 text-green-800': item.status === 'completed',
                'bg-red-100 text-red-800': item.status === 'error',
              }"
            >{{ item.status }}</span>
          </div>
          <pre v-if="item.input && Object.keys(item.input as object).length > 0" class="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-xs text-text-muted">{{ JSON.stringify(item.input, null, 2) }}</pre>
          <pre v-if="item.output !== null" class="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-xs text-text">{{ item.output }}</pre>
          <pre v-if="item.error !== null" class="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-xs text-error">{{ item.error }}</pre>
        </div>
      </div>

      <!-- Reasoning (collapsed) -->
      <div v-else-if="item.itemType === 'reasoning'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <div class="flex-1">
          <button
            class="text-xs text-text-muted hover:text-text"
            @click="toggleReasoning(item.key)"
          >
            {{ expandedReasoning.has(item.key) ? "▼" : "▶" }} Reasoning
          </button>
          <pre
            v-if="expandedReasoning.has(item.key)"
            class="mt-1 overflow-x-auto rounded-lg bg-surface p-3 font-mono text-xs text-text-muted whitespace-pre-wrap"
          >{{ item.text }}</pre>
        </div>
      </div>

      <!-- Posted update (markdown) -->
      <div v-else-if="item.itemType === 'run-update'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <div class="flex-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-text">
          <MarkdownContent :markdown="item.message" />
        </div>
      </div>

      <!-- Part summary (one-line) -->
      <div v-else-if="item.itemType === 'part-summary'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <span class="text-xs text-text-muted italic">{{ item.summary }}</span>
      </div>

      <!-- Session status marker -->
      <div v-else-if="item.itemType === 'session-status'" class="flex items-center gap-2">
        <span class="shrink-0 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <span
          class="rounded-full px-2 py-0.5 text-xs font-medium"
          :class="{
            'bg-blue-100 text-blue-800': item.label === 'busy',
            'bg-gray-100 text-gray-600': item.label === 'idle',
            'bg-orange-100 text-orange-800': item.label === 'retrying',
          }"
        >{{ item.label }}</span>
      </div>

      <!-- Event line -->
      <div v-else-if="item.itemType === 'event-line'" class="flex items-start gap-2">
        <span class="shrink-0 pt-0.5 font-mono text-xs text-text-muted">{{ formatTime(item.at) }}</span>
        <span class="text-xs text-text-muted">{{ item.label }}</span>
      </div>
    </div>
  </div>
</template>
