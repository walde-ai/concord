<script setup lang="ts">
import { ref, computed } from "vue";
import type { PeakHoursDto } from "../infra/types";
import WModal from "../design-system/w-modal.vue";

const props = defineProps<{
  peakHours: PeakHoursDto | null;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "save", value: PeakHoursDto | null): void;
}>();

const start = ref(props.peakHours?.start ?? "09:00");
const end = ref(props.peakHours?.end ?? "17:00");
const timezone = ref(props.peakHours?.timezone ?? defaultTimezone());

const timezones = computed(() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  // Etc/GMT* zones use POSIX-inverted signs (Etc/GMT+8 is UTC-8) and trip up users;
  // the dedicated fixedOffsets list below covers fixed-offset use cases cleanly.
  const filtered = supported.filter((tz) => !tz.startsWith("Etc/") || tz === "Etc/UTC");
  return filtered.length > 0 ? filtered : fallbackTimezones();
});

interface FixedOffset {
  readonly value: string;
  readonly label: string;
}

const fixedOffsets: readonly FixedOffset[] = (() => {
  const offsets: FixedOffset[] = [];
  for (let hours = 14; hours >= -12; hours -= 1) {
    const sign = hours >= 0 ? "+" : "-";
    const abs = Math.abs(hours);
    const value = `${sign}${String(abs).padStart(2, "0")}:00`;
    const label = `UTC${hours === 0 ? "" : `${sign}${abs}`}`;
    offsets.push({ value, label });
  }
  return offsets;
})();

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function fallbackTimezones(): string[] {
  return ["UTC", "Europe/Zurich", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
}

function handleSave(): void {
  emit("save", { start: start.value, end: end.value, timezone: timezone.value });
}

function handleClear(): void {
  emit("save", null);
}
</script>

<template>
  <WModal test-id="peak-hours-modal" @close="emit('close')">
    <h2 class="mb-4 font-accent text-2xl font-medium text-primary">Peak hours</h2>
    <div class="space-y-4">
      <label class="block">
        <span class="font-heading text-xs text-text-muted">Start</span>
        <input
          v-model="start"
          type="time"
          class="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        />
      </label>
      <label class="block">
        <span class="font-heading text-xs text-text-muted">End</span>
        <input
          v-model="end"
          type="time"
          class="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        />
      </label>
      <label class="block">
        <span class="font-heading text-xs text-text-muted">Timezone</span>
        <select
          v-model="timezone"
          class="mt-1 block w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 font-text text-sm text-text focus:border-primary focus:outline-none"
        >
          <optgroup label="Fixed offsets">
            <option v-for="o in fixedOffsets" :key="o.value" :value="o.value">{{ o.label }}</option>
          </optgroup>
          <optgroup label="Geographic">
            <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
          </optgroup>
        </select>
      </label>
    </div>
    <div class="mt-5 flex items-center justify-between gap-3">
      <button
        class="cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
        @click="handleClear"
      >
        Clear
      </button>
      <button
        class="flex h-10 cursor-pointer items-center rounded-full bg-primary px-6 font-heading text-sm font-medium text-white transition-[filter] hover:brightness-90 active:brightness-75"
        @click="handleSave"
      >
        Save
      </button>
    </div>
  </WModal>
</template>
