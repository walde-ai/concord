import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./render-markdown";

// The model posts status updates (post_update) and ask_question context as
// Markdown. The operator must see any URL in those surfaces as a clickable
// link — in particular the GitHub issue URL posted when a spec is created.
// `marked` autolinks bare URLs and DOMPurify preserves the resulting anchor;
// these tests lock that behavior in so a marked/DOMPurify config change or a
// hand-rolled replacement cannot silently un-link URLs.
describe("renderMarkdown — URL auto-linking", () => {
  it("renders a bare URL as a clickable anchor with the URL as href", () => {
    const html = renderMarkdown("Spec created: https://github.com/owner/repo/issues/1");
    expect(html).toContain('<a href="https://github.com/owner/repo/issues/1">');
    expect(html).toContain("https://github.com/owner/repo/issues/1");
  });

  it("autolinks multiple bare URLs in the same message", () => {
    const html = renderMarkdown("See https://example.com/a and https://example.com/b");
    expect(html).toContain('<a href="https://example.com/a">');
    expect(html).toContain('<a href="https://example.com/b">');
  });

  it("preserves Markdown formatting alongside autolinked URLs", () => {
    const html = renderMarkdown("**Done**\n\nIssue: https://github.com/owner/repo/issues/2");
    expect(html).toContain("<strong>Done</strong>");
    expect(html).toContain('<a href="https://github.com/owner/repo/issues/2">');
  });

  it("strips disallowed markup (script) but keeps links", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\nLink: https://example.com/safe',
    );
    expect(html).not.toContain("<script");
    expect(html).toContain('<a href="https://example.com/safe">');
  });

  it("returns an empty string for empty input without throwing", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
