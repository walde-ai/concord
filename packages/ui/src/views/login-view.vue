<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/use-auth-store";
import { safeRedirectTarget } from "../infra/redirect-target";
import WInput from "../design-system/w-input.vue";

const WALDEN_QUOTES = [
  'I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived.',
  'Rather than love, than money, than fame, give me truth.',
  'Our life is frittered away by detail. Simplify, simplify.',
  'I learned this, at least, by my experiment: that if one advances confidently in the direction of his dreams, and endeavors to live the life which he has imagined, he will meet with a success unexpected in common hours.',
  'Not till we are lost, in other words not till we have lost the world, do we begin to find ourselves.',
  'Things do not change; we change.',
  'Heaven is under our feet as well as over our heads.',
  'If you have built castles in the air, your work need not be lost; that is where they should be. Now put the foundations under them.',
  'However mean your life is, meet it and live it; do not shun it and call it hard names.',
  'What lies before us and what lies behind us are small matters compared to what lies within us.',
];

const auth = useAuthStore();
const router = useRouter();

const username = ref("");
const password = ref("");
const currentQuote = ref("");

onMounted(() => {
  const index = Math.floor(Math.random() * WALDEN_QUOTES.length);
  currentQuote.value = WALDEN_QUOTES[index];
});

async function handleSubmit(): Promise<void> {
  if (username.value.length === 0 || password.value.length === 0) {
    return;
  }
  const ok = await auth.login(username.value, password.value);
  if (ok) {
    // Honor the deep-link destination preserved by the router guard;
    // fall back to the events dashboard when none was captured.
    const redirect = safeRedirectTarget(router.currentRoute.value.query.redirect);
    router.push(redirect ?? "/events");
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center"
    style="background-color: var(--color-background)"
  >
    <div class="flex w-full max-w-3xl overflow-hidden" style="min-height: 420px">
      <!-- Left panel: login form -->
      <div class="flex flex-1 flex-col justify-center px-10 py-12">
        <div class="mb-2 flex items-center gap-3 self-start">
          <img src="/concord.png" alt="Concord" class="h-12 w-12 rounded-full" />
          <span class="font-accent text-4xl text-primary">Concord</span>
        </div>
        <p class="mb-8 self-start font-heading text-xs text-text-muted">
          Made with <span class="text-primary">♥</span> by
          <a
            href="https://walde.ai"
            target="_blank"
            rel="noopener noreferrer"
            class="cursor-pointer underline underline-offset-2 transition-colors hover:text-primary"
          >walde.ai</a>
        </p>

        <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
          <div class="flex flex-col gap-1">
            <label for="username" class="text-sm font-medium" style="color: var(--color-text)">Username</label>
            <WInput
              id="username"
              v-model="username"
              type="text"
              placeholder="Username"
              :disabled="auth.authenticating"
            />
          </div>

          <div class="flex flex-col gap-1">
            <label for="password" class="text-sm font-medium" style="color: var(--color-text)">Password</label>
            <WInput
              id="password"
              v-model="password"
              type="password"
              placeholder="Password"
              :disabled="auth.authenticating"
            />
          </div>

          <button
            type="submit"
            class="mt-2 w-full rounded px-4 py-2 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            style="background-color: var(--color-primary)"
            :disabled="auth.authenticating || username.length === 0 || password.length === 0"
          >
            {{ auth.authenticating ? "Logging in…" : "Log in" }}
          </button>

          <p v-if="auth.loginError !== null" class="text-sm" style="color: #c0392b">
            {{ auth.loginError }}
          </p>
        </form>
      </div>

      <!-- Right panel: Walden quote (hidden on mobile) -->
      <div class="hidden md:flex flex-1 flex-col justify-center px-10 py-12">
        <blockquote class="font-accent text-xl italic leading-relaxed" style="color: var(--color-text-muted)">
          "{{ currentQuote }}"
        </blockquote>
      </div>
    </div>
  </div>
</template>
