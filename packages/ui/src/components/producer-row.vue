<script setup lang="ts">
import type { ProducerDto } from "../infra/types";
import ToggleSwitch from "../design-system/toggle-switch.vue";

const props = defineProps<{
  producer: ProducerDto;
}>();

const emit = defineEmits<{
  (event: "toggle", id: string, enabled: boolean): void;
}>();

function truncate(id: string): string {
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

function handleToggle(enabled: boolean): void {
  emit("toggle", props.producer.id, enabled);
}
</script>

<template>
  <tr class="border-b border-border hover:bg-surface">
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ truncate(producer.id) }}</td>
    <td class="px-3 py-2">
      <ToggleSwitch
        v-if="producer.disableable"
        :model-value="producer.enabled"
        label="Toggle producer enabled"
        @update:model-value="handleToggle"
      />
      <span v-else class="text-sm text-text-muted">Always on</span>
    </td>
  </tr>
</template>
