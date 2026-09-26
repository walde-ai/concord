import { defineStore, acceptHMRUpdate } from "pinia";
import { ref } from "vue";
import { ApiClient } from "../infra/api-client";
import { StreamClient } from "../infra/stream-client";
import { RunActivityReducer, type ActivityItem } from "../infra/run-activity-reducer";
import type { EventDto, RunDto, ProducerDto, ConsumerDto, ContextDto, PeakHoursDto, SecretPair, SecretOperation, ConsumerSecretOperation, StreamFrame, ListResult, RunFormDto, AnswerMapDto, EventTemplateDto, FieldOptionDto, LogEntryDto, LogLevel, RunActivityFrame, RunUpdateDto, WidgetDescriptor } from "../infra/types";

export const useConcordStore = defineStore("concord", () => {
  const api = new ApiClient();
  const stream = new StreamClient();

  const events = ref<EventDto[]>([]);
  const runs = ref<RunDto[]>([]);
  const producers = ref<ProducerDto[]>([]);
  const consumers = ref<ConsumerDto[]>([]);
  const contexts = ref<ContextDto[]>([]);
  const paused = ref(false);
  const peakHours = ref<PeakHoursDto | null>(null);
  const peakIndicatorTick = ref(0);
  const eventsTotal = ref(0);
  const runsTotal = ref(0);
  const contextsTotal = ref(0);
  const eventsOffset = ref(0);
  const runsOffset = ref(0);
  const contextsOffset = ref(0);
  const eventsLimit = ref(50);
  const runsLimit = ref(50);
  const contextsLimit = ref(50);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const abortingIds = ref<string[]>([]);
  const restartingIds = ref<string[]>([]);
  const restartedAs = ref<Record<string, string>>({});
  const forms = ref<Record<string, RunFormDto[]>>({});
  const eventTemplates = ref<EventTemplateDto[]>([]);
  const logs = ref<LogEntryDto[]>([]);
  const logsTotal = ref(0);
  const logsOffset = ref(0);
  const logsLimit = ref(50);
  const logSources = ref<string[]>([]);
  const logFilters = ref<{ level: LogLevel | ""; source: string; text: string }>({ level: "", source: "", text: "" });
  const reducersByRun: Map<string, RunActivityReducer> = new Map();
  const activityItems = ref<Record<string, ActivityItem[]>>({});
  const subscribedRuns = ref<Record<string, boolean>>({});
  const runUpdates = ref<Record<string, RunUpdateDto[]>>({});
  const widgets = ref<WidgetDescriptor[]>([]);

  let streamConnected = false;
  let peakInterval: ReturnType<typeof setInterval> | null = null;

  async function loadEvents(limit = 50, offset = 0): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result: ListResult<EventDto> = await api.listEvents({ limit, offset });
      events.value = result.items;
      eventsTotal.value = result.total;
      eventsOffset.value = result.offset;
      eventsLimit.value = result.limit;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreEvents(): Promise<void> {
    const nextOffset = eventsOffset.value + eventsLimit.value;
    if (nextOffset >= eventsTotal.value) {
      return;
    }
    loading.value = true;
    try {
      const result = await api.listEvents({ limit: eventsLimit.value, offset: nextOffset });
      events.value = [...events.value, ...result.items];
      eventsTotal.value = result.total;
      eventsOffset.value = nextOffset;
    } finally {
      loading.value = false;
    }
  }

  async function loadRuns(limit = 50, offset = 0): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result: ListResult<RunDto> = await api.listRuns({ limit, offset });
      runs.value = result.items;
      runsTotal.value = result.total;
      runsOffset.value = result.offset;
      runsLimit.value = result.limit;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreRuns(): Promise<void> {
    const nextOffset = runsOffset.value + runsLimit.value;
    if (nextOffset >= runsTotal.value) {
      return;
    }
    loading.value = true;
    try {
      const result = await api.listRuns({ limit: runsLimit.value, offset: nextOffset });
      runs.value = [...runs.value, ...result.items];
      runsTotal.value = result.total;
      runsOffset.value = nextOffset;
    } finally {
      loading.value = false;
    }
  }

  async function loadProducers(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      producers.value = await api.listProducers();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function loadConsumers(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      consumers.value = await api.listConsumers();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function setProducerEnabled(id: string, enabled: boolean): Promise<void> {
    const index = producers.value.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const previous = producers.value[index].enabled;
    producers.value[index] = { ...producers.value[index], enabled };
    try {
      await api.setProducerEnabled(id, enabled);
    } catch (cause) {
      producers.value[index] = { ...producers.value[index], enabled: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setConsumerEnabled(id: string, enabled: boolean): Promise<void> {
    const index = consumers.value.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const previous = consumers.value[index].enabled;
    consumers.value[index] = { ...consumers.value[index], enabled };
    try {
      await api.setConsumerEnabled(id, enabled);
    } catch (cause) {
      consumers.value[index] = { ...consumers.value[index], enabled: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setConsumerWaitForOffPeak(id: string, waitForOffPeak: boolean): Promise<void> {
    const index = consumers.value.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const previous = consumers.value[index].waitForOffPeak;
    consumers.value[index] = { ...consumers.value[index], waitForOffPeak };
    try {
      const updated = await api.setConsumerWaitForOffPeak(id, waitForOffPeak);
      consumers.value[index] = updated;
    } catch (cause) {
      consumers.value[index] = { ...consumers.value[index], waitForOffPeak: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setConsumerConfig(id: string, values: Record<string, string>): Promise<void> {
    const index = consumers.value.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const previous = consumers.value[index].configValues;
    consumers.value[index] = { ...consumers.value[index], configValues: { ...values } };
    try {
      const updated = await api.setConsumerConfig(id, values);
      consumers.value[index] = updated;
    } catch (cause) {
      consumers.value[index] = { ...consumers.value[index], configValues: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setConsumerSecrets(id: string, operation: ConsumerSecretOperation): Promise<void> {
    const index = consumers.value.findIndex((item) => item.id === id);
    if (index === -1) {
      return;
    }
    const previous = consumers.value[index].secretNames;
    const upcoming = new Set(previous);
    for (const upsert of operation.upserts) {
      upcoming.add(upsert.name);
    }
    for (const name of operation.deletes) {
      upcoming.delete(name);
    }
    consumers.value[index] = { ...consumers.value[index], secretNames: [...upcoming].sort() };
    try {
      const updated = await api.setConsumerSecrets(id, operation);
      consumers.value[index] = updated;
    } catch (cause) {
      consumers.value[index] = { ...consumers.value[index], secretNames: previous };
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function loadPeakHours(): Promise<void> {
    try {
      const result = await api.getPeakHours();
      peakHours.value = result.peakHours;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setPeakHours(value: PeakHoursDto | null): Promise<void> {
    const previous = peakHours.value;
    peakHours.value = value;
    try {
      const result = await api.setPeakHours(value);
      peakHours.value = result.peakHours;
    } catch (cause) {
      peakHours.value = previous;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function loadContexts(limit = 50, offset = 0): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result: ListResult<ContextDto> = await api.listContexts({ limit, offset });
      contexts.value = result.items;
      contextsTotal.value = result.total;
      contextsOffset.value = result.offset;
      contextsLimit.value = result.limit;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreContexts(): Promise<void> {
    const nextOffset = contextsOffset.value + contextsLimit.value;
    if (nextOffset >= contextsTotal.value) {
      return;
    }
    loading.value = true;
    try {
      const result = await api.listContexts({ limit: contextsLimit.value, offset: nextOffset });
      contexts.value = [...contexts.value, ...result.items];
      contextsTotal.value = result.total;
      contextsOffset.value = nextOffset;
    } finally {
      loading.value = false;
    }
  }

  async function createContext(name: string, payload: unknown, secrets: readonly SecretPair[]): Promise<void> {
    const created = await api.createContext(name, payload, secrets);
    contexts.value = [created, ...contexts.value];
    contextsTotal.value += 1;
  }

  async function updateContext(name: string, payload: unknown, secrets: SecretOperation): Promise<void> {
    const index = contexts.value.findIndex((item) => item.name === name);
    if (index === -1) {
      return;
    }
    const previous = contexts.value[index];
    contexts.value[index] = { ...previous, payload };
    try {
      const updated = await api.updateContext(name, payload, secrets);
      contexts.value[index] = updated;
    } catch (cause) {
      contexts.value[index] = previous;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function deleteContext(name: string): Promise<void> {
    await api.deleteContext(name);
    contexts.value = contexts.value.filter((item) => item.name !== name);
    contextsTotal.value = Math.max(0, contextsTotal.value - 1);
  }

  async function loadPauseState(): Promise<void> {
    try {
      const result = await api.getPauseState();
      paused.value = result.paused;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function setPauseState(pausedFlag: boolean): Promise<void> {
    const previous = paused.value;
    paused.value = pausedFlag;
    try {
      const result = await api.setPauseState(pausedFlag);
      paused.value = result.paused;
    } catch (cause) {
      paused.value = previous;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function replayEvent(id: string): Promise<void> {
    try {
      const created = await api.replayEvent(id);
      upsertEvent(created);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function isAborting(id: string): boolean {
    return abortingIds.value.includes(id);
  }

  function isRestarting(id: string): boolean {
    return restartingIds.value.includes(id);
  }

  async function abortRun(id: string): Promise<RunDto | undefined> {
    if (isAborting(id)) {
      return undefined;
    }
    abortingIds.value = [...abortingIds.value, id];
    error.value = null;
    try {
      const updated = await api.abortRun(id);
      upsertRun(updated);
      return updated;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    } finally {
      abortingIds.value = abortingIds.value.filter((existing) => existing !== id);
    }
  }

  async function restartRun(id: string): Promise<void> {
    if (isRestarting(id)) {
      return;
    }
    restartingIds.value = [...restartingIds.value, id];
    error.value = null;
    try {
      const created = await api.restartRun(id);
      upsertRun(created);
      restartedAs.value = { ...restartedAs.value, [id]: created.id };
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      restartingIds.value = restartingIds.value.filter((existing) => existing !== id);
    }
  }

  async function loadRunForms(runId: string): Promise<RunFormDto[]> {
    error.value = null;
    try {
      const items = await api.listRunForms(runId);
      forms.value = { ...forms.value, [runId]: items };
      return items;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return [];
    }
  }

  async function submitRunForm(runId: string, formId: string, answers: AnswerMapDto): Promise<RunFormDto | undefined> {
    error.value = null;
    try {
      const updated = await api.submitRunForm(runId, formId, answers);
      const existing = forms.value[runId] ?? [];
      forms.value = {
        ...forms.value,
        [runId]: existing.map((form) => (form.id === formId ? updated : form)),
      };
      return updated;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    }
  }

  async function loadRunUpdates(runId: string): Promise<RunUpdateDto[]> {
    error.value = null;
    try {
      const items = await api.listRunUpdates(runId);
      runUpdates.value = { ...runUpdates.value, [runId]: items };
      return items;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return [];
    }
  }

  async function loadEventTemplates(): Promise<void> {
    error.value = null;
    try {
      eventTemplates.value = await api.listEventTemplates();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function emitEventTemplate(id: string, answers: AnswerMapDto): Promise<EventDto | undefined> {
    error.value = null;
    try {
      const created = await api.emitEventTemplate(id, answers);
      upsertEvent(created);
      return created;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return undefined;
    }
  }

  async function resolveEventTemplateFieldOptions(templateId: string, fieldKey: string, answers: AnswerMapDto): Promise<FieldOptionDto[]> {
    error.value = null;
    try {
      return await api.resolveEventTemplateFieldOptions(templateId, fieldKey, answers);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      return [];
    }
  }

  async function loadLogs(limit = 50, offset = 0): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await api.queryLogs({
        limit,
        offset,
        level: logFilters.value.level === "" ? undefined : logFilters.value.level,
        source: logFilters.value.source === "" ? undefined : logFilters.value.source,
        text: logFilters.value.text === "" ? undefined : logFilters.value.text,
      });
      logs.value = result.items;
      logsTotal.value = result.total;
      logsOffset.value = result.offset;
      logsLimit.value = result.limit;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreLogs(): Promise<void> {
    const nextOffset = logsOffset.value + logsLimit.value;
    if (nextOffset >= logsTotal.value) {
      return;
    }
    loading.value = true;
    try {
      const result = await api.queryLogs({
        limit: logsLimit.value,
        offset: nextOffset,
        level: logFilters.value.level === "" ? undefined : logFilters.value.level,
        source: logFilters.value.source === "" ? undefined : logFilters.value.source,
        text: logFilters.value.text === "" ? undefined : logFilters.value.text,
      });
      logs.value = [...logs.value, ...result.items];
      logsTotal.value = result.total;
      logsOffset.value = nextOffset;
    } finally {
      loading.value = false;
    }
  }

  async function loadLogSources(): Promise<void> {
    try {
      logSources.value = await api.listLogSources();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function loadWidgets(): Promise<void> {
    error.value = null;
    try {
      widgets.value = await api.listWidgets();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function upsertEvent(event: EventDto): void {
    const index = events.value.findIndex((item) => item.id === event.id);
    if (index === -1) {
      events.value = [event, ...events.value];
      eventsTotal.value += 1;
    } else {
      events.value[index] = event;
    }
  }

  function upsertRun(run: RunDto): void {
    const index = runs.value.findIndex((item) => item.id === run.id);
    if (index === -1) {
      runs.value = [run, ...runs.value];
      runsTotal.value += 1;
    } else {
      runs.value[index] = run;
    }
  }

  function handleFrame(frame: StreamFrame): void {
    if (frame.type === "event.created") {
      const event = frame.data as EventDto;
      upsertEvent(event);
    } else if (frame.type === "run.created") {
      const run = frame.data as RunDto;
      upsertRun(run);
    } else if (frame.type === "run.state_changed") {
      const updated = frame.data as RunDto;
      upsertRun(updated);
    } else if (frame.type === "system.paused_changed") {
      paused.value = (frame.data as { paused: boolean }).paused;
    } else if (frame.type === "system.peak_hours_changed") {
      peakHours.value = frame.data as PeakHoursDto | null;
    } else if (frame.type === "run.activity") {
      const activityFrame = frame.data as RunActivityFrame;
      pushActivityFrame(activityFrame);
    } else if (frame.type === "run.update") {
      const activityFrame = frame.data as RunActivityFrame;
      pushActivityFrame(activityFrame);
      // A live post_update also lands in the persisted Updates cache so an open
      // Updates section reflects it without a refetch.
      const payload = activityFrame.payload as { message?: unknown; updateId?: unknown };
      if (typeof payload.updateId === "string" && typeof payload.message === "string") {
        appendLiveRunUpdate(activityFrame.runId, payload.updateId, payload.message, activityFrame.at);
      }
    }
  }

  function pushActivityFrame(activityFrame: RunActivityFrame): void {
    const runId = activityFrame.runId;
    let reducer = reducersByRun.get(runId);
    if (reducer === undefined) {
      reducer = new RunActivityReducer();
      reducersByRun.set(runId, reducer);
    }
    reducer.push(activityFrame);
    activityItems.value = { ...activityItems.value, [runId]: reducer.getItems() };
  }

  function appendLiveRunUpdate(runId: string, updateId: string, message: string, at: string): void {
    const existing = runUpdates.value[runId] ?? [];
    if (existing.some((update) => update.id === updateId)) {
      return;
    }
    const dto: RunUpdateDto = {
      id: updateId,
      runId,
      consumerId: "",
      message,
      createdAt: at,
    };
    runUpdates.value = { ...runUpdates.value, [runId]: [...existing, dto] };
  }

  function subscribeToRunActivity(runId: string): void {
    if (subscribedRuns.value[runId]) {
      return;
    }
    subscribedRuns.value = { ...subscribedRuns.value, [runId]: true };
    stream.send(JSON.stringify({ type: "subscribe", runId }));
  }

  function unsubscribeFromRunActivity(runId: string): void {
    if (!subscribedRuns.value[runId]) {
      return;
    }
    subscribedRuns.value = { ...subscribedRuns.value, [runId]: false };
    stream.send(JSON.stringify({ type: "unsubscribe", runId }));
  }

  function isSubscribedToRunActivity(runId: string): boolean {
    return subscribedRuns.value[runId] === true;
  }

  function clearActivity(runId: string): void {
    const reducer = reducersByRun.get(runId);
    if (reducer !== undefined) {
      reducer.clear();
    }
    const nextItems = { ...activityItems.value };
    delete nextItems[runId];
    activityItems.value = nextItems;
  }

  function connectStream(): void {
    if (streamConnected) {
      return;
    }
    streamConnected = true;
    stream.connect(handleFrame);
    if (peakInterval === null) {
      peakInterval = setInterval(() => {
        peakIndicatorTick.value += 1;
      }, 60_000);
    }
  }

  function disconnectStream(): void {
    streamConnected = false;
    stream.disconnect();
    if (peakInterval !== null) {
      clearInterval(peakInterval);
      peakInterval = null;
    }
  }

  return {
    events,
    runs,
    producers,
    consumers,
    contexts,
    paused,
    peakHours,
    peakIndicatorTick,
    eventsTotal,
    runsTotal,
    contextsTotal,
    eventsOffset,
    runsOffset,
    contextsOffset,
    eventsLimit,
    runsLimit,
    contextsLimit,
    loading,
    error,
    abortingIds,
    restartingIds,
    restartedAs,
    forms,
    eventTemplates,
    logs,
    logsTotal,
    logsOffset,
    logsLimit,
    logSources,
    logFilters,
    activityItems,
    subscribedRuns,
    runUpdates,
    widgets,
    isAborting,
    isRestarting,
    loadEvents,
    loadMoreEvents,
    loadRuns,
    loadMoreRuns,
    loadProducers,
    loadConsumers,
    loadContexts,
    loadMoreContexts,
    createContext,
    updateContext,
    deleteContext,
    setProducerEnabled,
    setConsumerEnabled,
    setConsumerWaitForOffPeak,
    setConsumerConfig,
    setConsumerSecrets,
    loadPauseState,
    setPauseState,
    loadPeakHours,
    setPeakHours,
    replayEvent,
    abortRun,
    restartRun,
    loadRunForms,
    submitRunForm,
    loadRunUpdates,
    loadEventTemplates,
    emitEventTemplate,
    resolveEventTemplateFieldOptions,
    loadLogs,
    loadMoreLogs,
    loadLogSources,
    loadWidgets,
    clearActivity,
    subscribeToRunActivity,
    unsubscribeFromRunActivity,
    isSubscribedToRunActivity,
    connectStream,
    disconnectStream,
    handleFrame,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConcordStore, import.meta.hot));
}
