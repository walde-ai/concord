<script setup lang="ts">
import { ref } from "vue";
import type { ConsumerDto, ConsumerSecretOperation } from "../infra/types";
import ToggleSwitch from "../design-system/toggle-switch.vue";
import ConsumerConfigPanel from "./consumer-config-panel.vue";

const props = defineProps<{
  consumer: ConsumerDto;
}>();

const emit = defineEmits<{
  (event: "toggle", id: string, enabled: boolean): void;
  (event: "toggleWaitForOffPeak", id: string, waitForOffPeak: boolean): void;
  (event: "saveConfig", id: string, values: Record<string, string>): void;
  (event: "saveSecrets", id: string, operation: ConsumerSecretOperation): void;
}>();

const showConfig = ref(false);

function truncate(id: string): string {
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

function handleToggle(enabled: boolean): void {
  emit("toggle", props.consumer.id, enabled);
}

function handleWaitToggle(waitForOffPeak: boolean): void {
  emit("toggleWaitForOffPeak", props.consumer.id, waitForOffPeak);
}

function handleSaveConfig(values: Record<string, string>): void {
  emit("saveConfig", props.consumer.id, values);
  showConfig.value = false;
}

function handleSaveSecrets(operation: ConsumerSecretOperation): void {
  emit("saveSecrets", props.consumer.id, operation);
}
</script>

<template>
  <tr class="border-b border-border hover:bg-surface">
    <td class="px-3 py-2 font-mono text-xs">
      <button class="text-text-muted hover:text-primary hover:underline" @click="showConfig = true">{{ truncate(consumer.id) }}</button>
    </td>
    <td class="px-3 py-2">
      <ToggleSwitch
        :model-value="consumer.enabled"
        label="Toggle consumer enabled"
        @update:model-value="handleToggle"
      />
    </td>
    <td class="px-3 py-2">
      <ToggleSwitch
        :model-value="consumer.waitForOffPeak"
        label="Toggle wait for off peak"
        @update:model-value="handleWaitToggle"
      />
    </td>
    <ConsumerConfigPanel
      v-if="showConfig"
      :consumer="consumer"
      @close="showConfig = false"
      @save="handleSaveConfig"
      @save-secrets="handleSaveSecrets"
    />
  </tr>
</template>
