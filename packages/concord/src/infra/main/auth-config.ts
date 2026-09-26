import type { Argon2Parameters } from "../adapters/auth/argon2-password-secret-deriver";
import { OWASP_ARGON2ID_PARAMETERS } from "../adapters/auth/argon2-password-secret-deriver";

export interface AuthConfig {
  readonly argon2: Argon2Parameters;
  readonly handshakeTtlMs: number;
  readonly sessionLifetimeMs: number;
  readonly freshnessWindowMs: number;
  readonly pepper: string;
}

export const DEFAULT_HANDSHAKE_TTL_MS = 30_000;
export const DEFAULT_SESSION_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

export function defaultAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    argon2: overrides.argon2 ?? OWASP_ARGON2ID_PARAMETERS,
    handshakeTtlMs: overrides.handshakeTtlMs ?? DEFAULT_HANDSHAKE_TTL_MS,
    sessionLifetimeMs: overrides.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS,
    freshnessWindowMs: overrides.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS,
    pepper: overrides.pepper ?? "concord-default-pepper",
  };
}
