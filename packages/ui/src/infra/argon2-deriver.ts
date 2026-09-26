import { argon2id } from "hash-wasm";

const OWASP_PARAMETERS = {
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
};

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

export async function derivePasswordDigest(password: string, saltHex: string): Promise<string> {
  const salt = hexToBytes(saltHex);
  const digest = await argon2id({
    password,
    salt,
    parallelism: OWASP_PARAMETERS.parallelism,
    iterations: OWASP_PARAMETERS.iterations,
    memorySize: OWASP_PARAMETERS.memorySize,
    hashLength: OWASP_PARAMETERS.hashLength,
    outputType: "binary",
  });
  return bytesToHex(new Uint8Array(digest));
}
