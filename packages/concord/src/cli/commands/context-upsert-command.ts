import { readFileSync } from "node:fs";
import { Argon2PasswordSecretDeriver, OWASP_ARGON2ID_PARAMETERS, type Argon2Parameters } from "../../infra/adapters/auth/argon2-password-secret-deriver";
import type { ContextDto } from "../../infra/adapters/api/api-dtos";
import { createSrpLoginClient } from "../client/srp-login-client";
import {
  signedCreateContext,
  signedUpdateContext,
  type SecretPairInput,
} from "../client/signed-api-client";

export interface ContextUpsertInput {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly name: string;
  readonly payload: unknown;
  readonly secrets: Readonly<Record<string, string>>;
  readonly argon2?: Argon2Parameters;
}

export async function contextUpsertCommand(input: ContextUpsertInput): Promise<ContextDto> {
  const params = input.argon2 ?? OWASP_ARGON2ID_PARAMETERS;
  const deriver = new Argon2PasswordSecretDeriver(params);
  const loginClient = createSrpLoginClient(deriver);

  let session;
  try {
    session = await loginClient.login(input.origin, input.username, input.password);
  } catch (cause) {
    throw new Error(
      `could not log in to ${input.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const secretPairs = toSecretPairs(input.secrets);

  const createResult = await signedCreateContext(input.origin, session, {
    name: input.name,
    payload: input.payload,
    secrets: secretPairs,
  });

  if (createResult.status === 200 && createResult.body.ok && createResult.body.data !== undefined) {
    return createResult.body.data;
  }
  if (createResult.status !== 409) {
    const message = createResult.body.error?.message ?? "unknown error";
    throw new Error(`POST /api/contexts failed (${createResult.status}): ${message}`);
  }

  const updateResult = await signedUpdateContext(input.origin, session, input.name, {
    payload: input.payload,
    secrets: { upserts: secretPairs, deletes: [] },
  });

  const envelope = updateResult.body;
  if (updateResult.status !== 200 || !envelope.ok || envelope.data === undefined) {
    const message = envelope.error?.message ?? "unknown error";
    throw new Error(`PUT /api/contexts/${input.name} failed (${updateResult.status}): ${message}`);
  }
  return envelope.data;
}

function toSecretPairs(secrets: Readonly<Record<string, string>>): readonly SecretPairInput[] {
  return Object.entries(secrets).map(([name, value]) => ({ name, value }));
}

export function readContentValue(raw: string): unknown {
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    const text = readFileSync(path, "utf8");
    return parseJson(text, `file ${path}`);
  }
  return parseJson(raw, "--content");
}

export function readSecretsValue(raw: string): Record<string, string> {
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    const text = readFileSync(path, "utf8");
    return parseSecretsObject(JSON.parse(text), `file ${path}`);
  }
  return parseSecretsObject(JSON.parse(raw), "--secrets");
}

function parseJson(text: string, source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed;
}

function parseSecretsObject(value: unknown, source: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object of string values`);
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new Error(`${source} secret "${name}" must be a string value`);
    }
    result[name] = entry;
  }
  return result;
}
