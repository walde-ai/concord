<script setup lang="ts">
import { ref, computed } from "vue";
import type { ConsumerDto, ConsumerConfigValues, ConsumerSecretOperation } from "../infra/types";
import WModal from "../design-system/w-modal.vue";

interface SecretRowState {
  readonly key: string;
  readonly label: string;
  readonly existing: boolean;
  value: string;
  markedDeleted: boolean;
}

const props = defineProps<{
  consumer: ConsumerDto;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", values: Record<string, string>): void;
  (event: "saveSecrets", operation: ConsumerSecretOperation): void;
}>();

const draft = ref<ConsumerConfigValues>(initialValues());
const secretRows = ref<SecretRowState[]>(initialSecrets());

function initialValues(): ConsumerConfigValues {
  const values: ConsumerConfigValues = {};
  for (const parameter of props.consumer.configParameters) {
    const stored = props.consumer.configValues[parameter.key];
    values[parameter.key] = typeof stored === "string" && stored.length > 0 ? stored : parameter.defaultValue;
  }
  return values;
}

function initialSecrets(): SecretRowState[] {
  return props.consumer.secretParameters.map((parameter) => ({
    key: parameter.key,
    label: parameter.label,
    existing: props.consumer.secretNames.includes(parameter.key),
    value: "",
    markedDeleted: false,
  }));
}

const hasParameters = computed(() => props.consumer.configParameters.length > 0);
const hasSecrets = computed(() => props.consumer.secretParameters.length > 0);

function buildSecretOperation(): ConsumerSecretOperation {
  const upserts: { name: string; value: string }[] = [];
  const deletes: string[] = [];
  for (const row of secretRows.value) {
    if (row.markedDeleted) {
      if (row.existing) {
        deletes.push(row.key);
      }
      continue;
    }
    if (row.value !== "") {
      upserts.push({ name: row.key, value: row.value });
    }
  }
  return { upserts, deletes };
}

function handleSave(): void {
  emit("save", { ...draft.value });
  emit("saveSecrets", buildSecretOperation());
}

function toggleMarkDeleted(key: string): void {
  secretRows.value = secretRows.value.map((row) =>
    row.key === key ? { ...row, markedDeleted: !row.markedDeleted } : row,
  );
}
</script>

<template>
  <WModal :test-id="`consumer-config-modal-${consumer.id}`" @close="emit('close')">
    <h2 class="mb-4 font-accent text-2xl font-medium text-primary">Configure {{ consumer.id }}</h2>
    <div v-if="hasParameters" class="space-y-4">
      <label v-for="parameter in consumer.configParameters" :key="parameter.key" class="block">
        <span class="font-heading text-xs text-text-muted">{{ parameter.label }}</span>
        <input
          v-model="draft[parameter.key]"
          type="text"
          class="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        />
      </label>
    </div>
    <div v-if="hasSecrets" class="space-y-3 border-t border-border pt-4">
      <span class="font-heading text-xs font-medium uppercase tracking-wider text-secondary">Secrets</span>
      <p class="font-text text-xs text-text-muted">
        Existing secret values are not shown. Enter a new value to overwrite; leave the value empty to keep the current one.
      </p>
      <div
        v-for="row in secretRows"
        :key="row.key"
        class="flex flex-col gap-2 md:flex-row md:items-center"
        :class="row.markedDeleted ? 'opacity-50' : ''"
      >
        <input
          :value="row.label"
          disabled
          class="w-full rounded-md border border-border bg-surface px-3 py-2 font-text text-xs text-text opacity-60 md:w-2/5"
        />
        <input
          v-model="row.value"
          :disabled="row.markedDeleted"
          type="password"
          spellcheck="false"
          class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 md:flex-1"
          :placeholder="row.existing ? '(unchanged) enter new value to overwrite' : 'value'"
        />
        <button
          v-if="row.existing"
          class="cursor-pointer px-1 font-text text-sm transition-colors"
          :class="row.markedDeleted ? 'text-primary hover:opacity-70' : 'text-error hover:opacity-70'"
          @click="toggleMarkDeleted(row.key)"
        >
          {{ row.markedDeleted ? "Undo" : "Clear" }}
        </button>
      </div>
    </div>
    <div v-if="!hasParameters && !hasSecrets" class="pt-1">
      <p class="font-text text-xs text-text-muted">This consumer has no configurable parameters.</p>
    </div>
    <div class="mt-5 flex justify-end gap-3">
      <button
        class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
        @click="emit('close')"
      >
        Cancel
      </button>
      <button
        class="flex h-10 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
        @click="handleSave"
      >
        Save
      </button>
    </div>
  </WModal>
</template>
