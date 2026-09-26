<script setup lang="ts">
import type { ProducerDto } from "../infra/types";
import ToggleSwitch from "../design-system/toggle-switch.vue";

const props = defineProps<{
  producer: ProducerDto;
}>();

const emit = defineEmits<{
  (event: "toggle", id: string, enabled: boolean): void;
}>();

function handleToggle(enabled: boolean): void {
  emit("toggle", props.producer.id, enabled);
}
</script>

<template>
  <div class="rounded-xl border border-border bg-surface p-4">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0 flex-1">
        <p class="font-heading text-xs font-medium uppercase tracking-wider text-text-muted">Producer</p>
        <p class="mt-0.5 break-all font-mono text-xs text-text">{{ producer.id }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <span class="text-xs text-text-muted">
          {{ producer.enabled ? "Enabled" : (producer.disableable ? "Disabled" : "Always on") }}
        </span>
        <ToggleSwitch
          v-if="producer.disableable"
          :model-value="producer.enabled"
          label="Toggle producer enabled"
          @update:model-value="handleToggle"
        />
      </div>
    </div>
  </div>
</template>
