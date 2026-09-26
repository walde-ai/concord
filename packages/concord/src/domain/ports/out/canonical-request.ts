export interface CanonicalRequestInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: string;
}

export interface CanonicalRequestBuilder {
  build(input: CanonicalRequestInput): string;
}
