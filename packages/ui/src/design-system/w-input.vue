<script setup lang="ts">
import { ref, computed } from "vue";

const props = withDefaults(
  defineProps<{
    id?: string;
    type: "text" | "password" | "date" | "number";
    modelValue: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  {
    id: undefined,
    placeholder: "",
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const isVisible = ref(false);

const currentType = computed(() =>
  props.type === "password" && isVisible.value ? "text" : props.type,
);

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  emit("update:modelValue", target.value);
}

function toggleVisibility(): void {
  isVisible.value = !isVisible.value;
}
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :type="currentType"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="w-full rounded-md border border-border bg-background px-3 py-2 text-text placeholder:text-text-muted focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      @input="onInput"
    />
    <button
      v-if="type === 'password'"
      type="button"
      class="absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-semibold text-text-muted hover:text-text cursor-pointer"
      @click="toggleVisibility"
    >
      {{ isVisible ? "HIDE" : "SHOW" }}
    </button>
  </div>
</template>
