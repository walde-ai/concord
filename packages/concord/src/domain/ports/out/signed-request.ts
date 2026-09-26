export interface SignedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly session: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}
