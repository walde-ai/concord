<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from "vue";
import { ApiClient } from "../infra/api-client";
import type { WidgetDescriptor, WidgetPayload } from "../infra/types";
import WidgetStatusPanel from "./widget-status-panel.vue";

const props = defineProps<{
  descriptor: WidgetDescriptor;
}>();

// Generic renderers keyed by payload kind. Deployments add widgets by
// registering server-side implementations that emit one of these kinds;
// no deployment-specific code ships in the UI.
const KIND_COMPONENTS: Record<string, Component> = {
  "status-panel": WidgetStatusPanel,
};

const api = new ApiClient();
const payload = ref<WidgetPayload | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

const resolvedComponent = computed<Component | null>(() => KIND_COMPONENTS[props.descriptor.kind] ?? null);

async function fetchPayload(): Promise<void> {
  try {
    const raw = await api.getWidget(props.descriptor.id);
    if (raw.kind !== props.descriptor.kind) {
      errorMessage.value = `Unexpected payload kind "${raw.kind}" for widget "${props.descriptor.id}"`;
      loading.value = false;
      return;
    }
    payload.value = raw;
    errorMessage.value = null;
    loading.value = false;
  } catch (cause) {
    errorMessage.value = cause instanceof Error ? cause.message : String(cause);
    loading.value = false;
  }
}

onMounted(() => {
  void fetchPayload();
  if (props.descriptor.refresh.variant === "interval") {
    timer = setInterval(() => {
      void fetchPayload();
    }, props.descriptor.refresh.intervalMs);
  }
});

onUnmounted(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <header class="border-b border-border px-4 py-3">
      <h2 class="font-heading text-sm font-medium text-text">{{ descriptor.id }}</h2>
    </header>
    <div class="bg-background px-4 py-4">
      <p v-if="loading" class="font-text text-sm text-text-muted">Loading…</p>
      <p v-else-if="errorMessage !== null" class="font-text text-sm text-error">{{ errorMessage }}</p>
      <component
        v-else-if="resolvedComponent !== null && payload !== null"
        :is="resolvedComponent"
        :payload="payload"
      />
      <p v-else class="font-text text-sm text-text-muted">Unknown widget kind: {{ descriptor.kind }}</p>
    </div>
  </section>
</template>
