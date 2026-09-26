<script setup lang="ts">
import type { EventDto } from "../infra/types";
import { formatDatetime } from "../infra/format";
import { useConcordStore } from "../stores/use-concord-store";

const props = defineProps<{
  event: EventDto;
}>();

const emit = defineEmits<{
  (event: "click", id: string): void;
}>();

const store = useConcordStore();

function handleReplay(event: MouseEvent): void {
  event.stopPropagation();
  void store.replayEvent(props.event.id);
}

function handleClick(): void {
  emit("click", props.event.id);
}
</script>

<template>
  <div
    class="cursor-pointer rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary"
    @click="handleClick"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <p class="truncate font-text font-medium text-text">{{ event.type }}</p>
        <p class="mt-0.5 font-mono text-xs text-text-muted">{{ formatDatetime(event.datetime) }}</p>
      </div>
      <button
        class="shrink-0 cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
        @click="handleReplay"
      >
        Replay
      </button>
    </div>
    <dl class="mt-3 grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
      <dt class="text-text-muted">ID</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ event.id }}</dd>
      <dt class="text-text-muted">Producer</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ event.producerId }}</dd>
      <dt class="text-text-muted">Producer Event ID</dt>
      <dd class="col-span-2 break-all font-mono text-text-muted">{{ event.producerEventId }}</dd>
    </dl>
  </div>
</template>
