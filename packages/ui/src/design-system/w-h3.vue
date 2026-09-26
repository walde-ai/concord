<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  text?: string;
  article?: boolean;
}>();

const rootClass = computed(() => {
  if (props.article) {
    return "font-heading text-[11px] font-semibold uppercase tracking-[0.2em] text-secondary border-b border-border pb-1";
  }
  return "font-accent text-2xl text-primary";
});
</script>

<template>
  <h3 :class="rootClass">
    <slot>{{ text }}</slot>
  </h3>
</template>
