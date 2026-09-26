<script setup lang="ts">
import { ref, watch } from "vue";
import type { EventTemplateDto, AnswerMapDto, FieldOptionDto } from "../infra/types";
import FormFields from "./form-fields.vue";
import WModal from "../design-system/w-modal.vue";

const props = defineProps<{
  open: boolean;
  templates: EventTemplateDto[];
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  load: [];
  emit: [templateId: string, answers: AnswerMapDto];
  resolveOptions: [templateId: string, fieldKey: string, answers: AnswerMapDto, callback: (options: FieldOptionDto[]) => void];
}>();

type Step = "picker" | "form";

const step = ref<Step>("picker");
const selectedTemplate = ref<EventTemplateDto | null>(null);
const answers = ref<AnswerMapDto>({});

watch(
  () => props.open,
  (open) => {
    if (open) {
      step.value = "picker";
      selectedTemplate.value = null;
      answers.value = {};
      if (props.templates.length === 0) {
        emit("load");
      }
    }
  },
  { immediate: true },
);

function selectTemplate(template: EventTemplateDto): void {
  selectedTemplate.value = template;
  step.value = "form";
  answers.value = {};
}

function backToPicker(): void {
  step.value = "picker";
  selectedTemplate.value = null;
}

function handleUpdate(next: AnswerMapDto): void {
  answers.value = next;
}

function handleSend(): void {
  if (selectedTemplate.value === null) {
    return;
  }
  emit("emit", selectedTemplate.value.id, { ...answers.value });
}

function handleResolveOptions(fieldKey: string, answers: AnswerMapDto): Promise<FieldOptionDto[]> {
  if (selectedTemplate.value === null) {
    return Promise.resolve([]);
  }
  const templateId = selectedTemplate.value.id;
  return new Promise<FieldOptionDto[]>((resolve) => {
    emit("resolveOptions", templateId, fieldKey, answers, resolve);
  });
}

function handleClose(): void {
  step.value = "picker";
  selectedTemplate.value = null;
  answers.value = {};
  emit("close");
}
</script>

<template>
  <WModal v-if="props.open" test-id="add-event-modal" @close="handleClose">
    <template v-if="step === 'picker'">
      <h2 class="mb-4 font-accent text-2xl font-medium text-primary">Add Event</h2>
      <p v-if="props.error" class="mb-3 font-text text-sm text-error">{{ props.error }}</p>
      <p v-if="props.loading && props.templates.length === 0" class="font-text text-sm text-text-muted">Loading templates…</p>
      <p v-else-if="props.templates.length === 0" class="font-text text-sm text-text-muted">No event templates registered.</p>
      <div v-else class="flex flex-col gap-2">
        <button
          v-for="template in props.templates"
          :key="template.id"
          class="flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-primary"
          @click="selectTemplate(template)"
        >
          <span class="font-text text-sm font-semibold text-text">{{ template.label }}</span>
          <span class="font-text text-xs text-text-muted">{{ template.description }}</span>
          <span class="font-text text-xs text-text-muted">producer: {{ template.producerId }}</span>
        </button>
      </div>
    </template>

    <template v-else-if="step === 'form' && selectedTemplate !== null">
      <h2 class="mb-2 font-accent text-2xl font-medium text-primary">{{ selectedTemplate.label }}</h2>
      <p class="mb-4 font-heading text-sm leading-relaxed text-text-muted">{{ selectedTemplate.description }}</p>
      <p v-if="props.error" class="mb-3 font-text text-sm text-error">{{ props.error }}</p>
      <FormFields :fields="selectedTemplate.fields" :resolve-options="handleResolveOptions" @update:answers="handleUpdate" />
      <div class="mt-4 flex items-center justify-between">
        <button
          class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
          @click="backToPicker"
        >
          ← Back
        </button>
        <div class="flex justify-end gap-3">
          <button
            class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
            @click="handleClose"
          >
            Cancel
          </button>
          <button
            class="flex h-10 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
            @click="handleSend"
          >
            Send
          </button>
        </div>
      </div>
    </template>
  </WModal>
</template>
