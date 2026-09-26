import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/use-auth-store";
import { safeRedirectTarget } from "../infra/redirect-target";

const routes = [
  { path: "/", name: "home", component: () => import("../views/home-view.vue"), meta: { requiresAuth: true } },
  { path: "/login", name: "login", component: () => import("../views/login-view.vue") },
  { path: "/events", name: "events", component: () => import("../views/events-view.vue"), meta: { requiresAuth: true } },
  { path: "/events/:id", name: "event-detail", component: () => import("../views/event-detail-view.vue"), props: true, meta: { requiresAuth: true } },
  { path: "/runs", name: "runs", component: () => import("../views/runs-view.vue"), meta: { requiresAuth: true } },
  { path: "/runs/:id", name: "run-detail", component: () => import("../views/run-detail-view.vue"), props: true, meta: { requiresAuth: true } },
  { path: "/producers", name: "producers", component: () => import("../views/producers-view.vue"), meta: { requiresAuth: true } },
  { path: "/consumers", name: "consumers", component: () => import("../views/consumers-view.vue"), meta: { requiresAuth: true } },
  { path: "/contexts", name: "contexts", component: () => import("../views/contexts-view.vue"), meta: { requiresAuth: true } },
  { path: "/logs", name: "logs", component: () => import("../views/logs-view.vue"), meta: { requiresAuth: true } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.requiresAuth === true) {
    const auth = useAuthStore();
    if (!auth.isAuthenticated) {
      // Preserve the destination across the login bounce so deep links
      // (e.g. /runs/<id> opened from a notification) land on the artifact
      // after signing in instead of on a default page.
      return { name: "login", query: { redirect: to.fullPath } };
    }
  }
  if (to.name === "login") {
    const auth = useAuthStore();
    if (auth.isAuthenticated) {
      const redirect = safeRedirectTarget(to.query.redirect);
      if (redirect !== null) {
        return redirect;
      }
      return { name: "events" };
    }
  }
});
