<script setup lang="ts">
defineProps<{
  text?: string;
}>();
</script>

<template>
  <p class="font-text text-sm leading-relaxed text-text-muted">
    <slot>{{ text }}</slot>
  </p>
</template>
