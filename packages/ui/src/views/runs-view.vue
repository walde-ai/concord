<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import RunRow from "../components/run-row.vue";
import RunCard from "../components/run-card.vue";
import Pagination from "../components/pagination.vue";

const store = useConcordStore();
const router = useRouter();

onMounted(() => {
  store.loadRuns();
  store.connectStream();
});

function goToRun(id: string): void {
  router.push({ name: "run-detail", params: { id } });
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <WH1 text="Runs" />
    <p v-if="store.loading && store.runs.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <template v-else>
      <table class="mt-8 hidden w-full text-left md:table">
        <thead>
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">State</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Consumer</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Type</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Started</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Duration</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Datetime</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Producer</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Event Producer ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Actions</th>
          </tr>
        </thead>
        <tbody>
          <RunRow
            v-for="run in store.runs"
            :key="run.id"
            :run="run"
            @click="goToRun(run.id)"
          />
        </tbody>
      </table>
      <div class="mt-8 flex flex-col gap-3 md:hidden">
        <RunCard
          v-for="run in store.runs"
          :key="run.id"
          :run="run"
          @click="goToRun"
        />
      </div>
    </template>
    <Pagination
      :total="store.runsTotal"
      :offset="store.runsOffset"
      :limit="store.runsLimit"
      :loading="store.loading"
      @load-more="store.loadMoreRuns()"
    />
  </div>
</template>
