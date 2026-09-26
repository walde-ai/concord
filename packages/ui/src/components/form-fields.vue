<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { FieldDefinitionDto, AnswerMapDto, AnswerValueDto, FieldOptionDto } from "../infra/types";

const props = defineProps<{
  fields: readonly FieldDefinitionDto[];
  resolveOptions?: (fieldKey: string, answers: AnswerMapDto) => Promise<FieldOptionDto[]>;
}>();

const emit = defineEmits<{
  "update:answers": [answers: AnswerMapDto];
}>();

const draft = ref<AnswerMapDto>({});
const otherActive = ref<Record<string, boolean>>({});
const otherText = ref<Record<string, string>>({});
const dynamicOptions = ref<Record<string, FieldOptionDto[]>>({});
const dynamicLoading = ref<Record<string, boolean>>({});

type DynamicSelectFieldDto = Extract<FieldDefinitionDto, { readonly dynamic: true }>;

function isDynamicSelect(field: FieldDefinitionDto): field is DynamicSelectFieldDto {
  return field.inputType === "select" && "dynamic" in field && field.dynamic === true;
}

function seedDefaults(): void {
  const next: AnswerMapDto = {};
  const otherFlags: Record<string, boolean> = {};
  const otherValues: Record<string, string> = {};
  for (const field of props.fields) {
    if (field.inputType === "checkbox") {
      next[field.key] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : [];
    } else if (field.inputType === "select") {
      next[field.key] = typeof field.defaultValue === "string" ? field.defaultValue : "";
    } else {
      next[field.key] = field.defaultValue;
    }
    otherFlags[field.key] = false;
    otherValues[field.key] = "";
  }
  draft.value = next;
  otherActive.value = otherFlags;
  otherText.value = otherValues;
  dynamicOptions.value = {};
  dynamicLoading.value = {};
  emit("update:answers", { ...next });
}

watch(() => props.fields, seedDefaults, { immediate: true, deep: true });

const answers = computed(() => ({ ...draft.value }));

function publish(next: AnswerMapDto): void {
  draft.value = next;
  emit("update:answers", { ...next });
}

function toggleCheckbox(field: FieldDefinitionDto, option: string): void {
  if (field.inputType !== "checkbox") {
    return;
  }
  const current = asArray(draft.value[field.key]);
  const without = current.filter((entry) => entry !== option);
  const next = without.length === current.length ? [...current, option] : without;
  publish({ ...draft.value, [field.key]: next });
}

function handleSelectChange(field: FieldDefinitionDto, value: string): void {
  if (field.inputType !== "select") {
    return;
  }
  if (value === "__other__") {
    otherActive.value = { ...otherActive.value, [field.key]: true };
    publish({ ...draft.value, [field.key]: otherText.value[field.key] ?? "" });
  } else {
    otherActive.value = { ...otherActive.value, [field.key]: false };
    publish({ ...draft.value, [field.key]: value });
  }
}

function toggleOther(field: FieldDefinitionDto): void {
  if (field.inputType !== "checkbox" && field.inputType !== "select") {
    return;
  }
  const active = !otherActive.value[field.key];
  otherActive.value = { ...otherActive.value, [field.key]: active };
  if (field.inputType === "select") {
    if (active) {
      publish({ ...draft.value, [field.key]: otherText.value[field.key] ?? "" });
    } else if (typeof field.defaultValue === "string") {
      publish({ ...draft.value, [field.key]: field.defaultValue });
    }
  }
}

function setOtherText(field: FieldDefinitionDto, text: string): void {
  otherText.value = { ...otherText.value, [field.key]: text };
  if (otherActive.value[field.key]) {
    if (field.inputType === "select") {
      publish({ ...draft.value, [field.key]: text });
    } else if (field.inputType === "checkbox") {
      const declared = asArray(draft.value[field.key]).filter((entry) => isDeclaredOption(field, entry));
      const merged = text.length > 0 ? [...declared, text] : declared;
      publish({ ...draft.value, [field.key]: merged });
    }
  }
}

function setFreeText(field: FieldDefinitionDto, value: string): void {
  if (field.inputType !== "text" && field.inputType !== "textarea") {
    return;
  }
  publish({ ...draft.value, [field.key]: value });
}

function isDeclaredOption(field: FieldDefinitionDto, value: string): boolean {
  if (field.inputType !== "checkbox" && field.inputType !== "select") {
    return false;
  }
  if ("options" in field) {
    return field.options.includes(value);
  }
  return false;
}

function asArray(value: AnswerValueDto | undefined): string[] {
  return Array.isArray(value) ? [...value] : [];
}

async function fetchDynamicOptions(field: FieldDefinitionDto): Promise<void> {
  if (!isDynamicSelect(field)) {
    return;
  }
  if (props.resolveOptions === undefined) {
    return;
  }
  const depValue = draft.value[field.dependsOn];
  if (typeof depValue !== "string" || depValue.length === 0) {
    dynamicOptions.value = { ...dynamicOptions.value, [field.key]: [] };
    return;
  }
  dynamicLoading.value = { ...dynamicLoading.value, [field.key]: true };
  try {
    const options = await props.resolveOptions(field.key, { ...draft.value });
    dynamicOptions.value = { ...dynamicOptions.value, [field.key]: options };
    const current = draft.value[field.key];
    if (typeof current === "string" && current.length > 0 && !options.some((opt) => opt.value === current)) {
      publish({ ...draft.value, [field.key]: "" });
    }
  } finally {
    dynamicLoading.value = { ...dynamicLoading.value, [field.key]: false };
  }
}

watch(
  () => {
    const result: Record<string, string> = {};
    for (const field of props.fields) {
      if (isDynamicSelect(field)) {
        result[field.key] = String(draft.value[field.dependsOn] ?? "");
      }
    }
    return result;
  },
  (current, previous) => {
    for (const field of props.fields) {
      if (!isDynamicSelect(field)) {
        continue;
      }
      const prev = previous?.[field.key];
      const curr = current[field.key];
      if (prev !== curr) {
        void fetchDynamicOptions(field);
      }
    }
  },
  { deep: true },
);

defineExpose({ answers });
</script>

<template>
  <div class="space-y-4">
    <div v-for="field in fields" :key="field.key" class="flex flex-col gap-1.5">
      <span class="font-heading text-xs text-text-muted">{{ field.label }}</span>

      <template v-if="field.inputType === 'checkbox'">
        <label v-for="option in field.options" :key="option" class="flex items-center gap-2 font-text text-sm text-text">
          <input
            type="checkbox"
            class="accent-primary"
            :checked="asArray(draft[field.key]).includes(option)"
            @change="toggleCheckbox(field, option)"
          />
          {{ option }}
        </label>
        <label v-if="field.allowOther" class="flex items-center gap-2 font-text text-sm text-text">
          <input type="checkbox" class="accent-primary" :checked="otherActive[field.key]" @change="toggleOther(field)" />
          Other
        </label>
        <input
          v-if="field.allowOther && otherActive[field.key]"
          type="text"
          class="w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          placeholder="enter custom value"
          :value="otherText[field.key]"
          @input="(event) => setOtherText(field, (event.target as HTMLInputElement).value)"
        />
      </template>

      <template v-else-if="field.inputType === 'select' && isDynamicSelect(field)">
        <select
          class="w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
          :value="otherActive[field.key] ? '__other__' : (draft[field.key] as string)"
          :disabled="dynamicLoading[field.key]"
          @change="(event) => handleSelectChange(field, (event.target as HTMLSelectElement).value)"
        >
          <option value="" :disabled="true">
            {{ dynamicLoading[field.key] ? "Loading…" : "Select a value" }}
          </option>
          <option
            v-for="option in (dynamicOptions[field.key] ?? [])"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
          <option v-if="field.allowOther" value="__other__">Other</option>
        </select>
        <input
          v-if="field.allowOther && otherActive[field.key]"
          type="text"
          class="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          placeholder="enter custom value"
          :value="otherText[field.key]"
          @input="(event) => setOtherText(field, (event.target as HTMLInputElement).value)"
        />
      </template>

      <template v-else-if="field.inputType === 'select' && !isDynamicSelect(field)">
        <select
          class="w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
          :value="otherActive[field.key] ? '__other__' : (draft[field.key] as string)"
          @change="(event) => handleSelectChange(field, (event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
          <option v-if="field.allowOther" value="__other__">Other</option>
        </select>
        <input
          v-if="field.allowOther && otherActive[field.key]"
          type="text"
          class="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          placeholder="enter custom value"
          :value="otherText[field.key]"
          @input="(event) => setOtherText(field, (event.target as HTMLInputElement).value)"
        />
      </template>

      <textarea
        v-else-if="field.inputType === 'textarea'"
        class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        rows="12"
        :placeholder="field.placeholder"
        :value="draft[field.key]"
        @input="(event) => setFreeText(field, (event.target as HTMLTextAreaElement).value)"
      />
      <input
        v-else-if="field.inputType === 'text'"
        type="text"
        class="w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        :placeholder="field.placeholder"
        :value="draft[field.key]"
        @input="(event) => setFreeText(field, (event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>
