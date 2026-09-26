<script setup lang="ts">
import type { EventDto } from "../infra/types";
import { formatDatetime } from "../infra/format";
import { useConcordStore } from "../stores/use-concord-store";

const props = defineProps<{
  event: EventDto;
}>();

const store = useConcordStore();

function handleReplay(event: MouseEvent): void {
  event.stopPropagation();
  void store.replayEvent(props.event.id);
}
</script>

<template>
  <tr class="border-b border-border hover:bg-surface cursor-pointer">
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ event.id }}</td>
    <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">{{ formatDatetime(event.datetime) }}</td>
    <td class="px-3 py-2 font-mono text-xs">{{ event.type }}</td>
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ event.producerId }}</td>
    <td class="px-3 py-2 font-mono text-xs break-all text-text-muted">{{ event.producerEventId }}</td>
    <td class="px-3 py-2">
      <button
        class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
        @click="handleReplay"
      >
        Replay
      </button>
    </td>
  </tr>
</template>
