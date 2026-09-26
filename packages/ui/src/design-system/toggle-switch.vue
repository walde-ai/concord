<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modelValue: boolean;
  label?: string;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
}>();

const ariaChecked = computed(() => (props.modelValue ? "true" : "false"));

function toggle(): void {
  emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="ariaChecked"
    :aria-label="label"
    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors"
    :class="modelValue ? 'bg-primary' : 'bg-surface'"
    @click="toggle"
  >
    <span
      class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
      :class="modelValue ? 'translate-x-6' : 'translate-x-1'"
    />
  </button>
</template>
