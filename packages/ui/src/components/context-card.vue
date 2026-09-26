<script setup lang="ts">
import type { ContextDto } from "../infra/types";

const props = defineProps<{
  context: ContextDto;
}>();

const emit = defineEmits<{
  (event: "edit", name: string): void;
}>();

function preview(payload: unknown): string {
  const text = JSON.stringify(payload);
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function handleClick(): void {
  emit("edit", props.context.name);
}
</script>

<template>
  <div
    class="cursor-pointer rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary"
    @click="handleClick"
  >
    <div class="flex items-center justify-between gap-3">
      <p class="min-w-0 flex-1 break-all font-mono text-sm font-medium text-text">{{ context.name }}</p>
      <span class="shrink-0 text-xs text-text-muted">
        {{ context.secretNames.length === 1 ? "1 secret" : `${context.secretNames.length} secrets` }}
      </span>
    </div>
    <p class="mt-2 break-all font-mono text-xs text-text-muted">{{ preview(context.payload) }}</p>
  </div>
</template>
