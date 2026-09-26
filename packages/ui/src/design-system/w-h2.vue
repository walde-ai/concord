<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  text?: string;
  article?: boolean;
}>();

const rootClass = computed(() => {
  if (props.article) {
    return "font-accent text-2xl text-text";
  }
  return "font-accent text-4xl text-primary";
});
</script>

<template>
  <h2 :class="rootClass">
    <slot>{{ text }}</slot>
  </h2>
</template>
