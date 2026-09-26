export type ContextSecrets = Record<string, string>;

export interface ContextDescriptor {
  readonly name: string;
  readonly payload: unknown;
  readonly secrets: ContextSecrets;
}

export interface SecretPair {
  readonly name: string;
  readonly value: string;
}

export interface SecretOperation {
  readonly upserts: readonly SecretPair[];
  readonly deletes: readonly string[];
}
