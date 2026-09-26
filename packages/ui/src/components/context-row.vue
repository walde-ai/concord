<script setup lang="ts">
import type { ContextDto } from "../infra/types";

defineProps<{
  context: ContextDto;
}>();

const emit = defineEmits<{
  (event: "edit", name: string): void;
}>();

function preview(payload: unknown): string {
  const text = JSON.stringify(payload);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
</script>

<template>
  <tr
    class="cursor-pointer border-b border-border hover:bg-surface"
    @click="emit('edit', context.name)"
  >
    <td class="px-3 py-2 font-mono text-xs text-text-muted">{{ context.name }}</td>
    <td class="px-3 py-2 font-mono text-xs text-text">{{ preview(context.payload) }}</td>
    <td class="px-3 py-2 font-mono text-xs text-text-muted">
      {{ context.secretNames.length === 1 ? "1 secret" : `${context.secretNames.length} secrets` }}
    </td>
  </tr>
</template>
