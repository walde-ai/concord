<script setup lang="ts">
import { ref, computed } from "vue";
import type { RunFormDto, AnswerMapDto } from "../infra/types";
import FormFields from "./form-fields.vue";
import { renderMarkdown } from "../infra/render-markdown";

const props = defineProps<{
  form: RunFormDto;
  submitting: boolean;
}>();

const emit = defineEmits<{
  submit: [formId: string, answers: AnswerMapDto];
}>();

const answers = ref<AnswerMapDto>({});

const canSubmit = computed(() => !props.submitting);

const contextHtml = computed(() =>
  props.form.context && props.form.context.length > 0 ? renderMarkdown(props.form.context) : "",
);

function handleUpdate(next: AnswerMapDto): void {
  answers.value = next;
}

function handleSubmit(): void {
  if (!canSubmit.value) {
    return;
  }
  emit("submit", props.form.id, { ...answers.value });
}
</script>

<template>
  <div class="rounded-xl border border-border bg-surface p-4">
    <div
      v-if="contextHtml"
      class="mb-3 rounded-lg border border-border bg-background p-3 font-text text-sm text-text [&_h1]:mt-0 [&_h2]:mt-0 [&_h3]:mt-0 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_pre]:overflow-x-auto"
      v-html="contextHtml"
    ></div>
    <p class="font-text text-sm font-semibold text-text">{{ form.prompt }}</p>
    <div class="mt-4">
      <FormFields :fields="form.fields" @update:answers="handleUpdate" />
    </div>
    <div class="mt-4 flex justify-end">
      <button
        type="button"
        class="flex h-10 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canSubmit"
        @click="handleSubmit"
      >
        {{ submitting ? "Submitting…" : "Submit" }}
      </button>
    </div>
  </div>
</template>
