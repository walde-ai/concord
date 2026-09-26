<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { faArrowRightFromBracket, faGear, faPause, faPlay } from "@fortawesome/free-solid-svg-icons";
import { useAuthStore } from "./stores/use-auth-store";
import { useConcordStore } from "./stores/use-concord-store";
import { computePeakIndicator } from "./infra/peak-indicator";
import PeakHoursPanel from "./components/peak-hours-panel.vue";
import type { PeakHoursDto } from "./infra/types";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const concord = useConcordStore();

const showChrome = computed(() => route.name !== "login");
const showPeakPopover = ref(false);
const mobileSidebarOpen = ref(false);

const peakIndicator = computed(() => {
  void concord.peakIndicatorTick;
  return computePeakIndicator(concord.peakHours);
});

interface SidebarLink {
  readonly label: string;
  readonly path: string;
}

interface SidebarSection {
  readonly title: string;
  readonly links: readonly SidebarLink[];
}

const MAIN_SIDEBAR: readonly SidebarSection[] = [
  { title: "Overview", links: [{ label: "Home", path: "/" }] },
  {
    title: "Activity",
    links: [
      { label: "Events", path: "/events" },
      { label: "Runs", path: "/runs" },
      { label: "Logs", path: "/logs" },
    ],
  },
];

const CONFIGURATION_SIDEBAR: readonly SidebarSection[] = [
  {
    title: "Configuration",
    links: [
      { label: "Producers", path: "/producers" },
      { label: "Consumers", path: "/consumers" },
      { label: "Contexts", path: "/contexts" },
    ],
  },
];

// The configuration pages live in their own part of the app, reached from
// the gear icon in the nav rail — the rail selects the sidebar, the route
// decides which one is showing.
const isConfigurationSection = computed(
  () =>
    route.path.startsWith("/producers") ||
    route.path.startsWith("/consumers") ||
    route.path.startsWith("/contexts"),
);

const sidebarSections = computed(() =>
  isConfigurationSection.value ? CONFIGURATION_SIDEBAR : MAIN_SIDEBAR,
);

watch(
  () => auth.sessionInvalid,
  (invalid) => {
    if (!invalid) {
      return;
    }
    auth.acknowledgeSessionInvalid();
    // An expired session invalidates in-page API calls (e.g. loading a deep
    // linked run); carry the current page through the login bounce so the
    // user returns to what they opened. Several requests can fail together
    // (pause state, peak hours, run fetch), each raising sessionInvalid —
    // once we sit on the login route, keep the first captured redirect
    // instead of re-wrapping it on every notification.
    const current = router.currentRoute.value;
    if (current.name === "login") {
      return;
    }
    router.push({ name: "login", query: { redirect: current.fullPath } });
  },
);

onMounted(() => {
  if (showChrome.value) {
    concord.loadPauseState();
    concord.loadPeakHours();
  }
});

function isActive(path: string): boolean {
  if (path === "/") {
    return route.path === "/";
  }
  return route.path.startsWith(path);
}

function isMobileViewport(): boolean {
  return window.matchMedia("(max-width: 767px)").matches;
}

function openSection(rootPath: string, isAlreadyThere: () => boolean): void {
  if (isMobileViewport()) {
    // On mobile the rail icon toggles the section's sidebar as an overlay;
    // switching sections navigates to the section root and reveals it.
    if (!isAlreadyThere()) {
      void router.push(rootPath);
      mobileSidebarOpen.value = true;
    } else {
      mobileSidebarOpen.value = !mobileSidebarOpen.value;
    }
    return;
  }
  void router.push(rootPath);
}

function openMainSection(): void {
  openSection("/", () => !isConfigurationSection.value);
}

function openConfigurationSection(): void {
  openSection("/producers", () => isConfigurationSection.value);
}

function closeMobileSidebar(): void {
  mobileSidebarOpen.value = false;
}

function handlePauseToggle(): void {
  void concord.setPauseState(!concord.paused);
}

function handleLogout(): void {
  auth.logout();
  concord.disconnectStream();
  void router.push({ name: "login" });
}

function handleSavePeakHours(value: PeakHoursDto | null): void {
  void concord.setPeakHours(value);
  showPeakPopover.value = false;
}
</script>

<template>
  <!-- Workspace shell: nav rail + section sidebar + main, mirroring the
       Walde hub layout. The rail selects the part of the app (Concord,
       configuration); on mobile the sidebar opens as an overlay. -->
  <div v-if="showChrome" class="grid h-screen bg-background font-text text-text antialiased grid-cols-[var(--spacing-nav-rail)_1fr] md:grid-cols-[var(--spacing-nav-rail)_var(--spacing-sidebar)_1fr]">
    <nav class="h-full w-nav-rail overflow-y-auto">
      <div class="flex h-full flex-col items-center">
        <div class="space-y-8 py-10">
          <button
            aria-label="Concord"
            class="flex h-9 w-9 cursor-pointer items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-text"
            @click="openMainSection"
          >
            <img src="/concord.png" alt="" class="h-6 w-6 rounded-full" />
          </button>
          <button
            aria-label="Configuration"
            class="flex h-9 w-9 cursor-pointer items-center justify-center text-text transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-text"
            :class="isConfigurationSection ? 'opacity-100' : 'opacity-40 hover:opacity-100'"
            @click="openConfigurationSection"
          >
            <font-awesome-icon :icon="faGear" />
          </button>
        </div>
        <div class="flex-1" />
        <div class="mt-2 flex-shrink-0 pb-3">
          <button
            aria-label="Sign out"
            class="flex h-9 w-9 cursor-pointer items-center justify-center text-text opacity-40 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-text"
            @click="handleLogout"
          >
            <font-awesome-icon :icon="faArrowRightFromBracket" />
          </button>
        </div>
      </div>
    </nav>

    <div
      v-if="mobileSidebarOpen"
      class="fixed inset-0 z-30 bg-black/40 md:hidden"
      @click="closeMobileSidebar"
    />
    <aside
      class="fixed md:static inset-y-0 left-[var(--spacing-nav-rail)] md:left-auto z-40 flex h-full w-sidebar flex-col bg-background transition-transform duration-150 ease-out md:transition-none md:shadow-none"
      :class="mobileSidebarOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full md:translate-x-0'"
    >
      <div class="min-h-0 flex-1 overflow-y-auto pt-4">
        <div v-for="section in sidebarSections" :key="section.title" class="mb-6">
          <div class="px-3 py-1.5 font-heading text-xs font-medium uppercase tracking-wider text-text-muted">
            {{ section.title }}
          </div>
          <RouterLink
            v-for="link in section.links"
            :key="link.path"
            :to="link.path"
            class="block cursor-pointer px-3 py-1.5 font-heading text-sm transition-colors"
            :class="isActive(link.path) ? 'font-medium text-primary' : 'text-text hover:text-primary'"
            @click="closeMobileSidebar"
          >
            {{ link.label }}
          </RouterLink>
        </div>
      </div>
      <div class="mt-2 flex flex-shrink-0 flex-col gap-1 pb-3">
        <button
          class="w-full cursor-pointer rounded-full px-3 py-1.5 text-left font-heading text-xs font-medium transition-colors hover:bg-surface"
          :class="concord.paused ? 'text-error' : 'text-text-muted'"
          @click="handlePauseToggle"
        >
          {{ concord.paused ? "Resume" : "Pause" }}
        </button>
        <button
          class="w-full cursor-pointer rounded-full px-3 py-1.5 text-left font-heading text-xs font-medium transition-colors hover:bg-surface"
          :class="peakIndicator !== null && peakIndicator.peak ? 'text-primary' : 'text-text-muted'"
          @click="showPeakPopover = true"
        >
          {{ peakIndicator !== null ? peakIndicator.label : "Configure peak hours" }}
        </button>
        <p v-if="auth.session !== null" class="px-3 pt-1 font-heading text-xs text-text-muted">
          {{ auth.session.username }}
        </p>
        <p class="px-3 pt-1 font-heading text-xs text-text-muted">
          Made with <span class="text-primary">♥</span> by
          <a
            href="https://walde.ai"
            target="_blank"
            rel="noopener noreferrer"
            class="cursor-pointer underline underline-offset-2 transition-colors hover:text-primary"
          >walde.ai</a>
        </p>
      </div>
    </aside>

    <main class="h-full min-w-0 overflow-y-auto">
      <RouterView />
    </main>

    <PeakHoursPanel
      v-if="showPeakPopover"
      :peak-hours="concord.peakHours"
      @close="showPeakPopover = false"
      @save="handleSavePeakHours"
    />
  </div>
  <RouterView v-else />
</template>
