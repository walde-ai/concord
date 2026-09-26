<script setup lang="ts">
import { ref, computed } from "vue";
import type { LogEntryDto } from "../infra/types";
import { formatDatetime } from "../infra/format";

const props = defineProps<{
  entry: LogEntryDto;
}>();

const expanded = ref(false);

const hasFields = computed(() => props.entry.fields !== undefined && Object.keys(props.entry.fields).length > 0);

const levelClass = computed(() => {
  switch (props.entry.level) {
    case "debug":
      return "bg-gray-100 text-gray-600";
    case "info":
      return "bg-blue-100 text-blue-700";
    case "warn":
      return "bg-amber-100 text-amber-700";
    case "error":
      return "bg-red-100 text-red-700";
    default:
      return "bg-gray-100 text-gray-600";
  }
});

function toggle(): void {
  if (hasFields.value) {
    expanded.value = !expanded.value;
  }
}
</script>

<template>
  <!-- One expandable log line: level, timestamp and source run inline with
       the message; entries carrying structured fields reveal them below
       the line on click. -->
  <div
    class="rounded-lg px-2 py-2 transition-colors"
    :class="hasFields ? 'cursor-pointer hover:bg-surface' : ''"
    @click="toggle"
  >
    <div class="flex items-start gap-3">
      <span
        class="mt-0.5 inline-flex min-w-[3.5rem] justify-center rounded-full px-2 py-0.5 text-xs font-semibold"
        :class="levelClass"
      >
        {{ entry.level.toUpperCase() }}
      </span>
      <span class="mt-0.5 font-mono text-xs text-text-muted whitespace-nowrap">{{ formatDatetime(entry.timestamp) }}</span>
      <span class="mt-0.5 font-mono text-xs text-primary whitespace-nowrap">{{ entry.source }}</span>
      <p class="min-w-0 flex-1 font-text text-sm text-text break-words">{{ entry.message }}</p>
      <svg
        v-if="hasFields"
        class="mt-1 h-3 w-3 shrink-0 text-text-muted transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
    <div v-if="expanded && hasFields" class="mt-2 pl-[4.5rem]">
      <pre class="overflow-x-auto rounded-lg bg-surface px-3 py-2 text-xs font-mono text-text-muted">{{ JSON.stringify(entry.fields, null, 2) }}</pre>
    </div>
  </div>
</template>
