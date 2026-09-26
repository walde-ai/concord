<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter, RouterLink } from "vue-router";
import { ApiClient } from "../infra/api-client";
import { formatDatetime, formatDuration } from "../infra/format";
import { useConcordStore } from "../stores/use-concord-store";
import type { RunDto, RunFormDto, RunUpdateDto, AnswerMapDto } from "../infra/types";
import WH1 from "../design-system/w-h1.vue";
import WH3 from "../design-system/w-h3.vue";
import WP from "../design-system/w-p.vue";
import StateBadge from "../design-system/state-badge.vue";
import PayloadViewer from "../components/payload-viewer.vue";
import RunForm from "../components/run-form.vue";
import RunActivity from "../components/run-activity.vue";
import MarkdownContent from "../components/markdown-content.vue";

const props = defineProps<{ id: string }>();
const api = new ApiClient();
const store = useConcordStore();
const router = useRouter();

const run = ref<RunDto | null>(null);
const error = ref<string | null>(null);
const submitting = ref(false);
const activityOpen = ref(false);

const forms = computed<RunFormDto[]>(() => store.forms[props.id] ?? []);
const pendingForm = computed<RunFormDto | null>(() => forms.value.find((form) => form.status === "PENDING") ?? null);
const historicalForms = computed<RunFormDto[]>(() => forms.value.filter((form) => form.status === "ANSWERED"));
const restartedRunId = computed<string | undefined>(() => store.restartedAs[props.id]);
const activityItems = computed(() => store.activityItems[props.id] ?? []);
const updates = computed<RunUpdateDto[]>(() => store.runUpdates[props.id] ?? []);
const isLiveState = computed(() => run.value?.state === "RUNNING" || run.value?.state === "PENDING_INPUT");
const isStreaming = computed(
  () => activityOpen.value && store.isSubscribedToRunActivity(props.id) && isLiveState.value,
);
const showActivity = computed(() => {
  const state = run.value?.state;
  return state === "RUNNING" || state === "PENDING_INPUT" || activityItems.value.length > 0;
});

onMounted(async () => {
  try {
    run.value = await api.getRun(props.id);
    await Promise.all([store.loadRunForms(props.id), store.loadRunUpdates(props.id)]);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});

onUnmounted(() => {
  // Stop streaming this run's activity when navigating away; reduced items are
  // retained so re-opening is instant, subject to the reducer's rolling cap.
  store.unsubscribeFromRunActivity(props.id);
  activityOpen.value = false;
});

watch(
  () => store.runs.find((entry) => entry.id === props.id),
  (updated) => {
    if (updated !== undefined) {
      run.value = updated;
    }
  },
);

watch(
  () => run.value?.state,
  async (state) => {
    if (state === "PENDING_INPUT" || state === "RUNNING") {
      await store.loadRunForms(props.id);
    }
  },
);

// The Activity section streams a run's live activity only while it is open.
// Toggling the <details> subscribes/unsubscribes through the existing
// /api/stream socket so the broadcaster routes that run's frames to this tab.
function handleActivityToggle(event: Event): void {
  const details = event.target as HTMLDetailsElement;
  activityOpen.value = details.open;
  if (details.open) {
    store.subscribeToRunActivity(props.id);
  } else {
    store.unsubscribeFromRunActivity(props.id);
  }
}

async function handleAbort(): Promise<void> {
  if (run.value !== null) {
    const updated = await store.abortRun(run.value.id);
    if (updated !== undefined) {
      run.value = updated;
    }
  }
}

function handleRestart(): void {
  if (run.value !== null) {
    void store.restartRun(run.value.id);
  }
}

async function handleSubmit(formId: string, answers: AnswerMapDto): Promise<void> {
  if (run.value === null) {
    return;
  }
  submitting.value = true;
  try {
    await store.submitRunForm(run.value.id, formId, answers);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-5 py-8 md:px-12 md:py-20">
    <button
      class="mb-4 cursor-pointer px-1 font-text text-sm text-text-muted transition-colors hover:text-text"
      @click="router.push({ name: 'runs' })"
    >
      ← Back to runs
    </button>
    <p v-if="error" class="font-text text-sm text-error">{{ error }}</p>
    <template v-else-if="run">
      <div class="flex flex-wrap items-center gap-3">
        <WH1 text="Run" />
        <StateBadge :state="run.state" />
        <button
          v-if="run.state === 'RUNNING' || run.state === 'WAIT_FOR_OFFPEAK' || run.state === 'PENDING_INPUT'"
          :disabled="store.isAborting(run.id)"
          class="inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-4 font-heading text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
          @click="handleAbort"
        >
          {{ store.isAborting(run.id) ? "Aborting…" : "Abort" }}
        </button>
        <button
          v-if="run.state !== 'RUNNING' && run.state !== 'PENDING_INPUT'"
          :disabled="store.isRestarting(run.id)"
          class="inline-flex h-8 cursor-pointer items-center rounded-full border border-border px-4 font-heading text-xs font-medium text-text-muted transition-colors hover:bg-surface hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          @click="handleRestart"
        >
          {{ store.isRestarting(run.id) ? "Restarting…" : "Restart" }}
        </button>
        <RouterLink
          v-if="restartedRunId"
          :to="{ name: 'run-detail', params: { id: restartedRunId } }"
          class="font-mono text-xs text-primary hover:underline"
        >
          Restarted as Run {{ restartedRunId }}
        </RouterLink>
      </div>
      <div class="mt-4 space-y-1">
        <WP><span class="font-semibold">ID:</span> {{ run.id }}</WP>
        <WP><span class="font-semibold">Consumer:</span> {{ run.consumerId }}</WP>
        <WP><span class="font-semibold">Started:</span> {{ run.startedAt ? formatDatetime(run.startedAt) : "—" }}</WP>
        <WP v-if="run.startedAt && run.finishedAt">
          <span class="font-semibold">Finished:</span> {{ formatDatetime(run.finishedAt) }}
          <span class="text-text-muted">(duration {{ formatDuration(run.startedAt, run.finishedAt) }})</span>
        </WP>
        <WP v-else-if="run.startedAt"><span class="font-semibold">Finished:</span> running…</WP>
      </div>

      <div v-if="run.failure" class="mt-6">
        <WH3 text="Failure" />
        <div class="mt-2 space-y-1">
          <WP><span class="font-semibold">Error:</span> {{ run.failure.errorName }}</WP>
          <WP><span class="font-semibold">Message:</span> {{ run.failure.message }}</WP>
        </div>
        <div v-if="run.failure.stack" class="mt-3">
          <WP><span class="font-semibold">Stack trace</span></WP>
          <pre class="mt-1 overflow-x-auto rounded-xl bg-surface p-4 font-mono text-xs text-error">{{ run.failure.stack }}</pre>
        </div>
      </div>

      <div class="mt-6">
        <WH3 text="Event" />
        <div class="mt-2 space-y-1">
          <WP><span class="font-semibold">ID:</span> {{ run.event.id }}</WP>
          <WP><span class="font-semibold">Type:</span> {{ run.event.type }}</WP>
          <WP><span class="font-semibold">Producer ID:</span> {{ run.event.producerId }}</WP>
          <WP><span class="font-semibold">Datetime:</span> {{ formatDatetime(run.event.datetime) }}</WP>
        </div>
        <div class="mt-3">
          <PayloadViewer :payload="run.event.payload" />
        </div>
      </div>

      <div v-if="updates.length > 0" class="mt-6">
        <WH3 text="Updates" />
        <p class="mt-1 font-text text-xs text-text-muted">Posted by the agent at checkpoints. Persisted across reloads.</p>
        <div class="mt-3 space-y-3">
          <div
            v-for="update in updates"
            :key="update.id"
            class="rounded-xl border border-border bg-surface p-4"
          >
            <p class="mb-1 font-text text-xs text-text-muted">{{ formatDatetime(update.createdAt) }}</p>
            <MarkdownContent :markdown="update.message" />
          </div>
        </div>
      </div>

      <details
        v-if="showActivity"
        class="mt-6"
        @toggle="handleActivityToggle"
      >
        <summary class="flex cursor-pointer items-center gap-2 font-accent text-2xl text-primary">
          <span>Activity</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-heading text-xs font-medium"
            :class="isStreaming ? 'bg-primary-soft text-primary' : 'bg-surface text-text-muted'"
          >
            <span
              v-if="isStreaming"
              class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
            ></span>
            {{ isStreaming ? "Streaming" : "Not streaming" }}
          </span>
        </summary>
        <div class="mt-3">
          <p v-if="activityItems.length === 0" class="font-text text-xs text-text-muted">
            Activity is streamed live while the run is in progress and is not stored. Open this section while the run is live to follow it; a run opened after it finished has nothing to show.
          </p>
          <RunActivity v-else :items="activityItems" />
        </div>
      </details>

      <div v-if="pendingForm !== null" class="mt-6">
        <WH3 text="Input requested" />
        <p class="mt-1 font-text text-xs text-text-muted">This run is waiting for an answer before it continues.</p>
        <div class="mt-3">
          <RunForm :form="pendingForm" :submitting="submitting" @submit="handleSubmit" />
        </div>
      </div>

      <div v-if="historicalForms.length > 0" class="mt-6">
        <WH3 text="Form history" />
        <div class="mt-3 space-y-3">
          <div
            v-for="form in historicalForms"
            :key="form.id"
            class="rounded-xl border border-border bg-surface p-4"
          >
            <div
              v-if="form.context && form.context.length > 0"
              class="mb-3 rounded-lg border border-border bg-background p-3 font-text text-sm text-text"
            >
              <MarkdownContent :markdown="form.context" />
            </div>
            <p class="font-text text-sm font-semibold text-text">{{ form.prompt }}</p>
            <p class="mt-1 font-text text-xs text-text-muted">Round {{ form.round }} · answered {{ form.answeredAt ? formatDatetime(form.answeredAt) : "—" }}</p>
            <dl class="mt-3 space-y-2">
              <div v-for="field in form.fields" :key="field.key">
                <dt class="font-text text-xs font-medium text-text-muted">{{ field.label }}</dt>
                <dd class="font-text text-sm text-text">
                  <span v-if="Array.isArray(form.answers?.[field.key])">
                    {{ (form.answers?.[field.key] as string[]).join(", ") }}
                  </span>
                  <span v-else>{{ form.answers?.[field.key] ?? "—" }}</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="font-text text-sm text-text-muted">Loading…</p>
  </div>
</template>
