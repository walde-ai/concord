<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  payload: unknown;
}>();

interface Segment {
  readonly value: string;
  readonly isUrl: boolean;
}

const URL_PATTERN = /(https?:\/\/[^\s"\\<>]+)/g;

const segments = computed<Segment[]>(() => {
  const json = JSON.stringify(props.payload, null, 2);
  if (typeof json !== "string") {
    return [];
  }
  const result: Segment[] = [];
  let lastIndex = 0;
  for (const match of json.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result.push({ value: json.slice(lastIndex, index), isUrl: false });
    }
    result.push({ value: match[0], isUrl: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < json.length) {
    result.push({ value: json.slice(lastIndex), isUrl: false });
  }
  return result;
});
</script>

<template>
  <pre class="overflow-x-auto rounded-xl bg-surface p-4 font-mono text-sm text-text"><template
    v-for="(segment, index) in segments"
    :key="index"
  ><a
      v-if="segment.isUrl"
      :href="segment.value"
      target="_blank"
      rel="noopener noreferrer"
      class="cursor-pointer text-primary hover:underline"
    >{{ segment.value }}</a><span v-else>{{ segment.value }}</span></template></pre>
</template>
