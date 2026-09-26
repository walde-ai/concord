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
  <div class="rounded-xl border border-border bg-surface p-4">
    <p class="font-heading text-xs font-medium uppercase tracking-wider text-text-muted">Consumer</p>
    <p class="mt-0.5 break-all font-mono text-xs text-text">{{ consumer.id }}</p>

    <dl class="mt-3 divide-y divide-border">
      <div class="flex items-center justify-between gap-3 py-2">
        <div>
          <dt class="font-text text-sm text-text">Enabled</dt>
          <dd class="font-text text-xs text-text-muted">Run consumers for new events</dd>
        </div>
        <ToggleSwitch
          :model-value="consumer.enabled"
          label="Toggle consumer enabled"
          @update:model-value="handleToggle"
        />
      </div>
      <div class="flex items-center justify-between gap-3 py-2">
        <div>
          <dt class="font-text text-sm text-text">Wait for off peak</dt>
          <dd class="font-text text-xs text-text-muted">Defer runs during peak hours</dd>
        </div>
        <ToggleSwitch
          :model-value="consumer.waitForOffPeak"
          label="Toggle wait for off peak"
          @update:model-value="handleWaitToggle"
        />
      </div>
    </dl>

    <div v-if="consumer.configParameters.length > 0" class="mt-3">
      <button
        class="inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-4 font-heading text-xs font-medium text-text-muted transition-colors hover:bg-background hover:text-text"
        @click="showConfig = true"
      >
        Configure
      </button>
      <ConsumerConfigPanel
        v-if="showConfig"
        :consumer="consumer"
        @close="showConfig = false"
        @save="handleSaveConfig"
        @save-secrets="handleSaveSecrets"
      />
    </div>
  </div>
</template>
