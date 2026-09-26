<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import EventRow from "../components/event-row.vue";
import EventCard from "../components/event-card.vue";
import Pagination from "../components/pagination.vue";
import AddEventPanel from "../components/add-event-panel.vue";
import type { AnswerMapDto, FieldOptionDto } from "../infra/types";

const store = useConcordStore();
const router = useRouter();

const panelOpen = ref(false);

onMounted(() => {
  store.loadEvents();
  store.connectStream();
});

function goToEvent(id: string): void {
  router.push({ name: "event-detail", params: { id } });
}

function openPanel(): void {
  panelOpen.value = true;
  if (store.eventTemplates.length === 0) {
    store.loadEventTemplates();
  }
}

function handleEmit(templateId: string, answers: AnswerMapDto): void {
  store.emitEventTemplate(templateId, answers).then((created) => {
    if (created !== undefined) {
      panelOpen.value = false;
    }
  });
}

function handleResolveOptions(
  templateId: string,
  fieldKey: string,
  answers: AnswerMapDto,
  callback: (options: FieldOptionDto[]) => void,
): void {
  store.resolveEventTemplateFieldOptions(templateId, fieldKey, answers).then(callback);
}
</script>

<template>
  <div class="px-5 py-8 md:px-12 md:py-20">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <WH1 text="Events" />
      <button
        class="flex h-10 shrink-0 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
        @click="openPanel"
      >
        Add Event
      </button>
    </div>
    <p v-if="store.loading && store.events.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <template v-else>
      <table class="mt-8 hidden w-full text-left md:table">
        <thead>
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Datetime</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Type</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Producer ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Producer Event ID</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Actions</th>
          </tr>
        </thead>
        <tbody>
          <EventRow
            v-for="event in store.events"
            :key="event.id"
            :event="event"
            @click="goToEvent(event.id)"
          />
        </tbody>
      </table>
      <div class="mt-8 flex flex-col gap-3 md:hidden">
        <EventCard
          v-for="event in store.events"
          :key="event.id"
          :event="event"
          @click="goToEvent"
        />
      </div>
    </template>
    <Pagination
      :total="store.eventsTotal"
      :offset="store.eventsOffset"
      :limit="store.eventsLimit"
      :loading="store.loading"
      @load-more="store.loadMoreEvents()"
    />
    <AddEventPanel
      :open="panelOpen"
      :templates="store.eventTemplates"
      :loading="false"
      :error="store.error"
      @close="panelOpen = false"
      @load="store.loadEventTemplates()"
      @emit="handleEmit"
      @resolve-options="handleResolveOptions"
    />
  </div>
</template>
