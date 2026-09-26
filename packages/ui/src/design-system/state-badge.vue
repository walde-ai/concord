<script setup lang="ts">
import { computed } from "vue";
import type { RunState } from "../infra/types";

const props = defineProps<{
  state: RunState;
}>();

const badgeClasses: Record<RunState, string> = {
  SUCCEEDED: "bg-primary/10 text-primary",
  FAILED: "bg-error/10 text-error",
  RUNNING: "bg-amber-100 text-amber-700",
  NOT_STARTED: "bg-surface text-text-muted",
  ABORTED: "bg-amber-100 text-amber-800",
  TIMED_OUT: "bg-orange-100 text-orange-800",
  WAIT_FOR_OFFPEAK: "bg-amber-50 text-amber-600 border border-amber-200",
  PENDING_INPUT: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  SUPERSEDED: "bg-gray-100 text-gray-500 border border-gray-200",
};

const badgeClass = computed(() => badgeClasses[props.state]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
    :class="badgeClass"
  >
    <span v-if="state === 'RUNNING'" class="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
    <span v-else-if="state === 'PENDING_INPUT'" class="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
    {{ state }}
  </span>
</template>
