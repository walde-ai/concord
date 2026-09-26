<script setup lang="ts">
defineProps<{
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
}>();

defineEmits<{
  loadMore: [];
}>();
</script>

<template>
  <div class="flex items-center justify-between gap-3 py-3">
    <p class="font-text text-sm text-text-muted">{{ total }} total</p>
    <button
      v-if="offset + limit < total"
      class="inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-4 font-heading text-xs font-medium text-text transition-colors hover:bg-surface disabled:opacity-50"
      :disabled="loading"
      @click="$emit('loadMore')"
    >
      Load more
    </button>
  </div>
</template>
