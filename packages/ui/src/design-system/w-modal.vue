<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

/**
 * The Walde modal shell (from @walde.ai/ux): on mobile the card docks to
 * the bottom of the screen full-width with only its top corners rounded
 * (a bottom sheet) and slides in from below in a fast 150 ms; from `md:`
 * up it is a centred, fully-rounded card with no motion. Owns the shared
 * chrome: backdrop click and Escape both emit `close`. Unlike the hub
 * variant this shell is not teleported to <body>: Concord has no
 * transformed workspace ancestor that could clip a fixed overlay.
 */
defineProps<{
  testId: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const revealed = ref(false);

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  document.addEventListener("keydown", onDocumentKeyDown);
  // Two rAF ticks guarantee the sheet paints once in its off-screen
  // position before the class flips, so the transform actually animates.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      revealed.value = true;
    });
  });
});

onUnmounted(() => {
  document.removeEventListener("keydown", onDocumentKeyDown);
});
</script>

<template>
  <div
    :data-testid="testId"
    class="fixed inset-0 z-50 flex items-end bg-black/50 md:items-center md:justify-center md:px-5"
    @click.self="emit('close')"
  >
    <div
      class="max-h-[85vh] w-full overflow-y-auto overscroll-contain rounded-t-2xl bg-background p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] transition-transform duration-150 ease-out md:max-h-none md:max-w-lg md:rounded-xl md:pb-5"
      :class="revealed ? 'translate-y-0' : 'translate-y-full md:translate-y-0'"
    >
      <slot />
    </div>
  </div>
</template>
