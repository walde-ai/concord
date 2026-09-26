import { createHash } from "node:crypto";
import type {
  CanonicalRequestBuilder,
  CanonicalRequestInput,
} from "../../../domain/ports/out/canonical-request";

export class CanonicalRequest implements CanonicalRequestBuilder {
  public build(input: CanonicalRequestInput): string {
    const bodyDigest = createHash("sha256").update(input.body).digest("base64");
    return [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, bodyDigest].join("\n");
  }
}

export { type CanonicalRequestInput };
