<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useConcordStore } from "../stores/use-concord-store";
import WH1 from "../design-system/w-h1.vue";
import ContextRow from "../components/context-row.vue";
import ContextCard from "../components/context-card.vue";
import Pagination from "../components/pagination.vue";
import ContextEditPanel from "../components/context-edit-panel.vue";
import type { ContextDto, SecretPair, SecretOperation } from "../infra/types";

const store = useConcordStore();

const panelOpen = ref(false);
const editTarget = ref<ContextDto | null>(null);

onMounted(() => {
  store.loadContexts();
  store.connectStream();
});

function openCreate(): void {
  editTarget.value = null;
  panelOpen.value = true;
}

function openEdit(name: string): void {
  const found = store.contexts.find((item) => item.name === name);
  if (found === undefined) {
    return;
  }
  editTarget.value = found;
  panelOpen.value = true;
}

function handleCreate(name: string, payload: unknown, secrets: SecretPair[]): void {
  void store.createContext(name, payload, secrets);
  panelOpen.value = false;
}

function handleUpdate(name: string, payload: unknown, secrets: SecretOperation): void {
  void store.updateContext(name, payload, secrets);
  panelOpen.value = false;
}

function handleClose(): void {
  panelOpen.value = false;
  editTarget.value = null;
}

function handleDelete(name: string): void {
  void store.deleteContext(name);
  panelOpen.value = false;
  editTarget.value = null;
}
</script>

<template>
  <div class="px-5 py-8 md:px-12 md:py-20">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <WH1 text="Contexts" />
      <button
        class="flex h-10 shrink-0 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
        @click="openCreate"
      >
        Add Context
      </button>
    </div>
    <p v-if="store.loading && store.contexts.length === 0" class="mt-8 font-text text-sm text-text-muted">Loading…</p>
    <p v-else-if="store.error" class="mt-8 font-text text-sm text-error">{{ store.error }}</p>
    <template v-else>
      <table class="mt-8 hidden w-full text-left md:table">
        <thead>
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Name</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Payload</th>
            <th class="px-3 py-2 font-heading text-xs font-medium uppercase tracking-wider text-secondary">Secrets</th>
          </tr>
        </thead>
        <tbody>
          <ContextRow
            v-for="context in store.contexts"
            :key="context.name"
            :context="context"
            @edit="openEdit"
          />
        </tbody>
      </table>
      <div class="mt-8 flex flex-col gap-3 md:hidden">
        <ContextCard
          v-for="context in store.contexts"
          :key="context.name"
          :context="context"
          @edit="openEdit"
        />
      </div>
    </template>
    <Pagination
      :total="store.contextsTotal"
      :offset="store.contextsOffset"
      :limit="store.contextsLimit"
      :loading="store.loading"
      @load-more="store.loadMoreContexts()"
    />
    <ContextEditPanel
      :open="panelOpen"
      :target="editTarget"
      @close="handleClose"
      @create="handleCreate"
      @update="handleUpdate"
      @delete="handleDelete"
    />
  </div>
</template>
