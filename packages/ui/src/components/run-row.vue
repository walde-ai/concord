<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { RunDto } from "../infra/types";
import { formatDatetime, formatDuration } from "../infra/format";
import { useConcordStore } from "../stores/use-concord-store";
import StateBadge from "../design-system/state-badge.vue";

const props = defineProps<{
  run: RunDto;
}>();

const store = useConcordStore();

const restartedRunId = computed<string | undefined>(() => store.restartedAs[props.run.id]);

function handleAbort(event: MouseEvent): void {
  event.stopPropagation();
  void store.abortRun(props.run.id);
}

function handleRestart(event: MouseEvent): void {
  event.stopPropagation();
  void store.restartRun(props.run.id);
}
</script>

<template>
  <tr class="border-b border-border hover:bg-surface cursor-pointer">
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ run.id }}</td>
    <td class="px-3 py-2"><StateBadge :state="run.state" /></td>
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ run.consumerId }}</td>
    <td class="px-3 py-2 font-mono text-xs">{{ run.event.type }}</td>
    <td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-text-muted">
      {{ run.startedAt ? formatDatetime(run.startedAt) : "—" }}
    </td>
    <td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-text-muted">
      <span v-if="run.startedAt && run.finishedAt">{{ formatDuration(run.startedAt, run.finishedAt) }}</span>
      <span v-else-if="run.startedAt" class="text-text-muted/70">running…</span>
      <span v-else>—</span>
    </td>
    <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">{{ formatDatetime(run.event.datetime) }}</td>
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ run.event.producerId }}</td>
    <td class="px-3 py-2 font-mono text-xs break-all text-text-muted">{{ run.event.producerEventId }}</td>
    <td class="px-3 py-2 space-x-2">
      <button
        v-if="run.state === 'RUNNING' || run.state === 'WAIT_FOR_OFFPEAK'"
        :disabled="store.isAborting(run.id)"
        class="cursor-pointer px-1 font-text text-sm text-error transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
        @click="handleAbort"
      >
        {{ store.isAborting(run.id) ? "Aborting…" : "Abort" }}
      </button>
      <button
        v-if="run.state !== 'RUNNING'"
        :disabled="store.isRestarting(run.id)"
        class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        @click="handleRestart"
      >
        {{ store.isRestarting(run.id) ? "Restarting…" : "Restart" }}
      </button>
      <RouterLink
        v-if="restartedRunId"
        :to="{ name: 'run-detail', params: { id: restartedRunId } }"
        class="font-mono text-xs text-primary hover:underline"
        @click.stop
      >
        Restarted as Run {{ restartedRunId }}
      </RouterLink>
    </td>
  </tr>
</template>
