<script setup lang="ts">
import { onMounted } from "vue";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import WidgetHost from "../components/widget-host.vue";

const store = useConcordStore();

onMounted(() => {
  void store.loadWidgets();
});
</script>

<template>
  <div class="px-5 py-8 md:px-12 md:py-20">
    <header class="mb-10">
      <WH1 text="Home" />
    </header>
    <p v-if="store.widgets.length === 0 && store.error !== null" class="font-text text-sm text-error">{{ store.error }}</p>
    <p v-else-if="store.widgets.length === 0" class="font-text text-sm text-text-muted">No widgets available.</p>
    <div v-else class="grid gap-6 md:grid-cols-2">
      <WidgetHost
        v-for="descriptor in store.widgets"
        :key="descriptor.id"
        :descriptor="descriptor"
      />
    </div>
  </div>
</template>
