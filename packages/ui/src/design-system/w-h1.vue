<script setup lang="ts">
defineProps<{
  text?: string;
}>();
</script>

<template>
  <h1 class="font-accent text-6xl text-primary">
    <slot>{{ text }}</slot>
  </h1>
</template>
