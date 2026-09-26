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

const emit = defineEmits<{
  (event: "click", id: string): void;
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

function handleClick(): void {
  emit("click", props.run.id);
}
</script>

<template>
  <div
    class="cursor-pointer rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary"
    @click="handleClick"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <StateBadge :state="run.state" />
          <span class="truncate font-mono text-xs text-text-muted">{{ run.id }}</span>
        </div>
        <p class="mt-1.5 truncate font-text font-medium text-text">{{ run.event.type }}</p>
        <p class="mt-0.5 font-mono text-xs text-text-muted">{{ formatDatetime(run.event.datetime) }}</p>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-2">
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
      </div>
    </div>
    <RouterLink
      v-if="restartedRunId"
      :to="{ name: 'run-detail', params: { id: restartedRunId } }"
      class="mt-3 inline-block font-mono text-xs text-primary hover:underline"
      @click.stop
    >
      Restarted as Run {{ restartedRunId }}
    </RouterLink>
    <dl class="mt-3 grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
      <dt class="text-text-muted">Consumer</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ run.consumerId }}</dd>
      <dt class="text-text-muted">Started</dt>
      <dd class="col-span-2 font-mono text-text-muted">{{ run.startedAt ? formatDatetime(run.startedAt) : "—" }}</dd>
      <dt class="text-text-muted">{{ run.finishedAt ? "Finished" : "Duration" }}</dt>
      <dd class="col-span-2 font-mono text-text-muted">
        <span v-if="run.startedAt && run.finishedAt">
          {{ formatDatetime(run.finishedAt) }} ({{ formatDuration(run.startedAt, run.finishedAt) }})
        </span>
        <span v-else-if="run.startedAt">running…</span>
        <span v-else>—</span>
      </dd>
      <dt class="text-text-muted">Producer</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ run.event.producerId }}</dd>
      <dt class="text-text-muted">Producer Event ID</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ run.event.producerEventId }}</dd>
    </dl>
  </div>
</template>
