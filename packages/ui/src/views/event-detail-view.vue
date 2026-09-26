<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ApiClient } from "../infra/api-client";
import { useConcordStore } from "../stores/use-concord-store";
import { formatDatetime } from "../infra/format";
import type { EventDto, RunDto } from "../infra/types";
import WH1 from "../design-system/w-h1.vue";
import WH3 from "../design-system/w-h3.vue";
import WP from "../design-system/w-p.vue";
import PayloadViewer from "../components/payload-viewer.vue";
import RunRow from "../components/run-row.vue";
import RunCard from "../components/run-card.vue";
import StateBadge from "../design-system/state-badge.vue";

const props = defineProps<{ id: string }>();
const api = new ApiClient();
const store = useConcordStore();
const router = useRouter();

const event = ref<EventDto | null>(null);
const runs = ref<RunDto[]>([]);
const error = ref<string | null>(null);

onMounted(async () => {
  store.connectStream();
  try {
    event.value = await api.getEvent(props.id);
    const result = await api.listRunsByEvent(props.id);
    runs.value = result.items;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});

function goToRun(id: string): void {
  router.push({ name: "run-detail", params: { id } });
}

function handleReplay(): void {
  if (event.value !== null) {
    void store.replayEvent(event.value.id);
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <button
      class="mb-4 cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
      @click="router.push({ name: 'events' })"
    >
      ← Back to events
    </button>
    <p v-if="error" class="font-text text-sm text-error">{{ error }}</p>
    <template v-else-if="event">
      <div class="flex flex-wrap items-center gap-3">
        <WH1 :text="event.type" />
        <button
          v-if="event.producerId !== 'concord.replay'"
          class="inline-flex h-8 cursor-pointer items-center rounded-full bg-primary px-4 font-heading text-xs font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
          @click="handleReplay"
        >
          Replay
        </button>
        <span
          v-else
          class="inline-flex h-8 cursor-not-allowed items-center rounded-full bg-primary/40 px-4 font-heading text-xs font-medium text-white"
          title="Events produced by a replay cannot be replayed"
        >
          Replay
        </span>
      </div>
      <div class="mt-4 space-y-1">
        <WP><span class="font-semibold">ID:</span> {{ event.id }}</WP>
        <WP><span class="font-semibold">Producer ID:</span> {{ event.producerId }}</WP>
        <WP><span class="font-semibold">Producer Event ID:</span> {{ event.producerEventId }}</WP>
        <WP><span class="font-semibold">Datetime:</span> {{ formatDatetime(event.datetime) }}</WP>
      </div>
      <div class="mt-6">
        <WH3 text="Payload" />
        <div class="mt-2">
          <PayloadViewer :payload="event.payload" />
        </div>
      </div>
      <div class="mt-6">
        <WH3 text="Runs" />
        <table v-if="runs.length > 0" class="mt-2 hidden w-full text-left md:table">
          <thead>
            <tr class="border-b border-border">
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">ID</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">State</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Consumer</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Type</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Datetime</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Producer</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Producer ID</th>
              <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Actions</th>
            </tr>
          </thead>
          <tbody>
            <RunRow v-for="run in runs" :key="run.id" :run="run" @click="goToRun(run.id)" />
          </tbody>
        </table>
        <div v-if="runs.length > 0" class="mt-2 flex flex-col gap-3 md:hidden">
          <RunCard v-for="run in runs" :key="run.id" :run="run" @click="goToRun" />
        </div>
        <p v-if="runs.length === 0" class="mt-2 font-text text-sm text-text-muted">No runs for this event.</p>
      </div>
    </template>
    <p v-else class="font-text text-sm text-text-muted">Loading…</p>
  </div>
</template>
