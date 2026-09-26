export function extractRawJsonProducerEventId(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const candidate = (parsed as { eventId?: unknown }).eventId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
