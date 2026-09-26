import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureVerifier } from "../../../domain/ports/out/signature-verifier";

export class NodeHmacSignatureVerifier implements SignatureVerifier {
  public verify(key: string, message: string, signature: string): boolean {
    const expected = createHmac("sha256", key).update(message).digest("base64");
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, providedBuffer);
  }
}
