const encoder = new TextEncoder();

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export interface CanonicalInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: string;
}

export async function buildCanonical(input: CanonicalInput): Promise<string> {
  const bodyDigest = await sha256Base64(input.body);
  return [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, bodyDigest].join("\n");
}
