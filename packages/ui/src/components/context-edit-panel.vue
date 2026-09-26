<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ContextDto, SecretPair, SecretOperation } from "../infra/types";
import WModal from "../design-system/w-modal.vue";

interface EditTarget {
  readonly name: string;
  readonly payload: unknown;
  readonly secretNames: readonly string[];
}

interface SecretRow {
  readonly id: number;
  readonly existing: boolean;
  name: string;
  value: string;
  markedDeleted: boolean;
}

const props = defineProps<{ open: boolean; target: EditTarget | null }>();
const emit = defineEmits<{
  close: [];
  create: [name: string, payload: unknown, secrets: SecretPair[]];
  update: [name: string, payload: unknown, secrets: SecretOperation];
  delete: [name: string];
}>();

const nameText = ref("");
const jsonText = ref("");
const parseError = ref<string | null>(null);
const secretRows = ref<SecretRow[]>([]);
let nextRowId = 1;

const isEditing = computed(() => props.target !== null);

const parsedPayload = computed<unknown | null>(() => {
  const trimmed = jsonText.value.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
});

const isValid = computed(() => {
  if (!isEditing.value) {
    return nameText.value.trim() !== "" && parsedPayload.value !== null;
  }
  return parsedPayload.value !== null;
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      if (props.target !== null) {
        nameText.value = props.target.name;
        jsonText.value = JSON.stringify(props.target.payload, null, 2);
        secretRows.value = props.target.secretNames.map((name) => ({
          id: nextRowId++,
          existing: true,
          name,
          value: "",
          markedDeleted: false,
        }));
      } else {
        nameText.value = "";
        jsonText.value = "";
        secretRows.value = [];
      }
      parseError.value = null;
    }
  },
  { immediate: true },
);

function addSecretRow(): void {
  secretRows.value = [
    ...secretRows.value,
    { id: nextRowId++, existing: false, name: "", value: "", markedDeleted: false },
  ];
}

function removeNewRow(id: number): void {
  secretRows.value = secretRows.value.filter((row) => row.id !== id);
}

function toggleMarkDeleted(id: number): void {
  secretRows.value = secretRows.value.map((row) =>
    row.id === id ? { ...row, markedDeleted: !row.markedDeleted } : row,
  );
}

function buildCreateSecrets(): SecretPair[] {
  return secretRows.value
    .filter((row) => row.name.trim() !== "" && row.value !== "")
    .map((row) => ({ name: row.name.trim(), value: row.value }));
}

function buildUpdateOperation(): SecretOperation {
  const upserts: SecretPair[] = [];
  const deletes: string[] = [];
  for (const row of secretRows.value) {
    if (row.markedDeleted) {
      if (row.existing) {
        deletes.push(row.name);
      }
      continue;
    }
    if (row.existing) {
      if (row.value !== "") {
        upserts.push({ name: row.name, value: row.value });
      }
    } else if (row.name.trim() !== "" && row.value !== "") {
      upserts.push({ name: row.name.trim(), value: row.value });
    }
  }
  return { upserts, deletes };
}

function handleSave(): void {
  if (parsedPayload.value === null) {
    parseError.value = "Please enter valid JSON.";
    return;
  }
  if (!isEditing.value && nameText.value.trim() === "") {
    parseError.value = "Please enter a name.";
    return;
  }
  parseError.value = null;
  if (isEditing.value && props.target !== null) {
    emit("update", props.target.name, parsedPayload.value, buildUpdateOperation());
  } else {
    emit("create", nameText.value.trim(), parsedPayload.value, buildCreateSecrets());
  }
}

function handleDelete(): void {
  if (props.target === null) {
    return;
  }
  emit("delete", props.target.name);
}

function handleClose(): void {
  jsonText.value = "";
  nameText.value = "";
  secretRows.value = [];
  parseError.value = null;
  emit("close");
}
</script>

<template>
  <WModal v-if="props.open" test-id="context-edit-modal" @close="handleClose">
    <h2 class="mb-4 font-accent text-2xl font-medium text-primary">{{ isEditing ? "Edit Context" : "Add Context" }}</h2>

    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <label class="font-text text-sm font-medium text-text" for="context-name-field">Name</label>
        <input
          id="context-name-field"
          v-model="nameText"
          :disabled="isEditing"
          class="w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="my-context"
        />
        <p v-if="isEditing" class="font-text text-xs text-text-muted">The name is immutable.</p>
      </div>
      <div class="flex flex-col gap-1">
        <label class="font-text text-sm font-medium text-text" for="context-payload-field">Payload (JSON)</label>
        <textarea
          id="context-payload-field"
          v-model="jsonText"
          class="min-h-48 w-full resize-y rounded-md border border-border bg-background p-4 font-mono text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          placeholder='{ "key": "value" }'
          spellcheck="false"
        />
        <p v-if="jsonText.trim() !== '' && parsedPayload === null" class="font-text text-sm text-error">
          Invalid JSON.
        </p>
        <p v-if="parseError !== null" class="font-text text-sm text-error">
          {{ parseError }}
        </p>
      </div>

      <div class="flex flex-col gap-2 border-t border-border pt-4">
        <div class="flex items-center justify-between">
          <label class="font-text text-sm font-medium text-text">Secrets</label>
          <button
            class="inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-4 font-heading text-xs font-medium text-text-muted transition-colors hover:bg-surface hover:text-text"
            @click="addSecretRow"
          >
            + Add secret
          </button>
        </div>
        <p class="font-text text-xs text-text-muted">
          Existing secret values are not shown. Enter a new value to overwrite; leave the value empty to keep the current one.
        </p>
        <div
          v-for="row in secretRows"
          :key="row.id"
          class="flex flex-col gap-2 md:flex-row md:items-center"
          :class="row.markedDeleted ? 'opacity-50' : ''"
        >
          <input
            :value="row.name"
            :disabled="row.existing"
            class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:w-2/5"
            placeholder="SECRET_NAME"
            @input="(event) => { row.name = (event.target as HTMLInputElement).value }"
          />
          <input
            v-model="row.value"
            :disabled="row.markedDeleted"
            class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:flex-1"
            :placeholder="row.existing ? '(unchanged) enter new value to overwrite' : 'value'"
            type="password"
            spellcheck="false"
          />
          <button
            v-if="row.existing"
            class="cursor-pointer px-1 font-text text-sm transition-colors"
            :class="row.markedDeleted ? 'text-primary hover:opacity-70' : 'text-error hover:opacity-70'"
            @click="toggleMarkDeleted(row.id)"
          >
            {{ row.markedDeleted ? "Undo" : "Delete" }}
          </button>
          <button
            v-else
            class="cursor-pointer px-1 font-text text-sm text-error transition-opacity hover:opacity-70"
            @click="removeNewRow(row.id)"
          >
            Remove
          </button>
        </div>
        <p v-if="secretRows.length === 0" class="font-text text-xs text-text-muted">
          No secrets configured.
        </p>
      </div>
    </div>

    <div class="mt-5 flex flex-col gap-3">
      <div class="flex justify-end gap-3">
        <button
          class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
          @click="handleClose"
        >
          Cancel
        </button>
        <button
          class="flex h-10 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!isValid"
          @click="handleSave"
        >
          Save
        </button>
      </div>
      <button
        v-if="isEditing"
        class="cursor-pointer font-text text-sm text-error transition-opacity hover:opacity-70"
        @click="handleDelete"
      >
        Delete context
      </button>
    </div>
  </WModal>
</template>
