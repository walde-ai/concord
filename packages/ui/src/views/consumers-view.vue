<script setup lang="ts">
import { onMounted } from "vue";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import ConsumerRow from "../components/consumer-row.vue";
import ConsumerCard from "../components/consumer-card.vue";
import type { ConsumerSecretOperation } from "../infra/types";

const store = useConcordStore();

onMounted(() => {
  store.loadConsumers();
  store.connectStream();
});

function handleToggle(id: string, enabled: boolean): void {
  void store.setConsumerEnabled(id, enabled);
}

function handleToggleWaitForOffPeak(id: string, waitForOffPeak: boolean): void {
  void store.setConsumerWaitForOffPeak(id, waitForOffPeak);
}

function handleSaveConfig(id: string, values: Record<string, string>): void {
  void store.setConsumerConfig(id, values);
}

function handleSaveSecrets(id: string, operation: ConsumerSecretOperation): void {
  void store.setConsumerSecrets(id, operation);
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <WH1 text="Consumers" />
    <p v-if="store.loading && store.consumers.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <template v-else>
      <table class="mt-8 hidden w-full text-left md:table">
        <thead>
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Enabled</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Wait for off peak</th>
          </tr>
        </thead>
        <tbody>
          <ConsumerRow
            v-for="consumer in store.consumers"
            :key="consumer.id"
            :consumer="consumer"
            @toggle="handleToggle"
            @toggle-wait-for-off-peak="handleToggleWaitForOffPeak"
            @save-config="handleSaveConfig"
            @save-secrets="handleSaveSecrets"
          />
        </tbody>
      </table>
      <div class="mt-8 flex flex-col gap-3 md:hidden">
        <ConsumerCard
          v-for="consumer in store.consumers"
          :key="consumer.id"
          :consumer="consumer"
          @toggle="handleToggle"
          @toggle-wait-for-off-peak="handleToggleWaitForOffPeak"
          @save-config="handleSaveConfig"
          @save-secrets="handleSaveSecrets"
        />
      </div>
    </template>
  </div>
</template>
