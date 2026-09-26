<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import LogEntryRow from "../components/log-entry-row.vue";
import Pagination from "../components/pagination.vue";
import type { LogLevel } from "../infra/types";

const store = useConcordStore();

const levels: LogLevel[] = ["debug", "info", "warn", "error"];

onMounted(() => {
  store.loadLogs();
  store.loadLogSources();
});

watch(
  () => store.logFilters.level,
  () => store.loadLogs(),
);

watch(
  () => store.logFilters.source,
  () => store.loadLogs(),
);

let textTimeout: ReturnType<typeof setTimeout> | null = null;

watch(
  () => store.logFilters.text,
  (value) => {
    if (textTimeout !== null) {
      clearTimeout(textTimeout);
    }
    textTimeout = setTimeout(() => {
      void store.loadLogs();
      textTimeout = null;
    }, value.length === 0 ? 0 : 400);
  },
);
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <WH1 text="Logs" />

    <div class="mt-8 flex flex-wrap items-center gap-3">
      <select
        :value="store.logFilters.level"
        class="cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        @change="store.logFilters = { ...store.logFilters, level: ($event.target as HTMLSelectElement).value as LogLevel | '' }"
      >
        <option value="">All levels</option>
        <option v-for="level in levels" :key="level" :value="level">{{ level.toUpperCase() }}</option>
      </select>

      <select
        :value="store.logFilters.source"
        class="cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        @change="store.logFilters = { ...store.logFilters, source: ($event.target as HTMLSelectElement).value }"
      >
        <option value="">All sources</option>
        <option v-for="source in store.logSources" :key="source" :value="source">{{ source }}</option>
      </select>

      <input
        :value="store.logFilters.text"
        type="text"
        placeholder="Search message…"
        class="flex-1 rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        @input="store.logFilters = { ...store.logFilters, text: ($event.target as HTMLInputElement).value }"
      />
    </div>

    <p v-if="store.loading && store.logs.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <p v-else-if="store.logs.length === 0" class="mt-8 font-text text-sm text-text-muted">No log entries found.</p>
    <div v-else class="mt-8 flex flex-col gap-1">
      <LogEntryRow
        v-for="(entry, index) in store.logs"
        :key="entry.timestamp + '-' + index"
        :entry="entry"
      />
    </div>

    <Pagination
      :total="store.logsTotal"
      :offset="store.logsOffset"
      :limit="store.logsLimit"
      :loading="store.loading"
      @load-more="store.loadMoreLogs()"
    />
  </div>
</template>
