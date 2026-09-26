<script setup lang="ts">
import { computed } from "vue";
import type { StatusPanelItem, StatusPanelItemStatus, StatusPanelPayload } from "../infra/types";

const props = defineProps<{
  payload: StatusPanelPayload;
}>();

interface StatusBadge {
  readonly label: string;
  readonly classes: string;
}

const STATUS_BADGES: Record<StatusPanelItemStatus, StatusBadge> = {
  failed: { label: "✕", classes: "bg-error text-white" },
  success: { label: "✓", classes: "bg-primary text-white" },
  "in-progress": { label: "…", classes: "bg-blue-500 text-white" },
};

const isErrored = computed(() => props.payload.state.kind === "errored");
const errorMessage = computed(() =>
  props.payload.state.kind === "errored" ? props.payload.state.message : "",
);

function badgeFor(item: StatusPanelItem): StatusBadge {
  return STATUS_BADGES[item.status];
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
</script>

<template>
  <div>
    <p v-if="isErrored" class="text-text-muted">{{ errorMessage }}</p>
    <div v-else>
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span class="text-sm font-semibold text-text">{{ payload.title }}</span>
        <span v-if="payload.timestamp" class="text-xs text-text-muted">{{ formatTimestamp(payload.timestamp) }}</span>
      </div>
      <ul class="mt-3 flex flex-col gap-2">
        <li v-for="item in payload.items" :key="item.label" class="flex items-center gap-3">
          <span
            class="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold"
            :class="badgeFor(item).classes"
          >{{ badgeFor(item).label }}</span>
          <a v-if="item.link" :href="item.link" target="_blank" rel="noopener" class="text-sm text-text underline">{{ item.label }}</a>
          <span v-else class="text-sm text-text">{{ item.label }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
