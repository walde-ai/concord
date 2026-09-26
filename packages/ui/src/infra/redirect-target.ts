/**
 * Sanitizes a post-login redirect target carried through the `?redirect=`
 * query parameter. Deep links (e.g. /runs/<id>) opened while unauthenticated
 * bounce to /login; the intended destination must survive that bounce so the
 * user lands on the artifact they opened, not on a default page.
 *
 * Only same-app paths are accepted: it must start with a single "/" so
 * protocol-relative URLs ("//evil.example") and absolute URLs are rejected.
 */
export function safeRedirectTarget(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }
  return value;
}
