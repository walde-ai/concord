import { marked } from "marked";
import DOMPurify from "dompurify";

// Parse markdown to HTML with `marked` and sanitize with `dompurify` before the
// result is bound with v-html. Model-authored markdown is an injection vector
// (script tags, event handlers), so every rendered update — persisted or live —
// flows through this single sanitized path to keep the two surfaces consistent.
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}
