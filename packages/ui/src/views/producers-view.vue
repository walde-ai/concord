<script setup lang="ts">
import { onMounted } from "vue";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import ProducerRow from "../components/producer-row.vue";
import ProducerCard from "../components/producer-card.vue";

const store = useConcordStore();

onMounted(() => {
  store.loadProducers();
  store.connectStream();
});

function handleToggle(id: string, enabled: boolean): void {
  void store.setProducerEnabled(id, enabled);
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <WH1 text="Producers" />
    <p v-if="store.loading && store.producers.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <template v-else>
      <table class="mt-8 hidden w-full text-left md:table">
        <thead>
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Enabled</th>
          </tr>
        </thead>
        <tbody>
          <ProducerRow
            v-for="producer in store.producers"
            :key="producer.id"
            :producer="producer"
            @toggle="handleToggle"
          />
        </tbody>
      </table>
      <div class="mt-8 flex flex-col gap-3 md:hidden">
        <ProducerCard
          v-for="producer in store.producers"
          :key="producer.id"
          :producer="producer"
          @toggle="handleToggle"
        />
      </div>
    </template>
  </div>
</template>
