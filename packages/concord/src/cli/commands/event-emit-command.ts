import { Argon2PasswordSecretDeriver, OWASP_ARGON2ID_PARAMETERS, type Argon2Parameters } from "../../infra/adapters/auth/argon2-password-secret-deriver";
import type { EventDto } from "../../infra/adapters/api/api-dtos";
import { createSrpLoginClient, type LoginSession } from "../client/srp-login-client";
import { signedPostEvent } from "../client/signed-api-client";

export interface EventEmitInput {
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly type: string;
  readonly payload: unknown;
  readonly argon2?: Argon2Parameters;
}

export const CLI_PRODUCER_ID = "cli";

export async function eventEmitCommand(input: EventEmitInput): Promise<EventDto> {
  const params = input.argon2 ?? OWASP_ARGON2ID_PARAMETERS;
  const deriver = new Argon2PasswordSecretDeriver(params);
  const loginClient = createSrpLoginClient(deriver);

  let session: LoginSession;
  try {
    session = await loginClient.login(input.origin, input.username, input.password);
  } catch (cause) {
    throw new Error(
      `could not log in to ${input.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const result = await signedPostEvent(input.origin, session, {
    type: input.type,
    payload: input.payload,
    producerId: CLI_PRODUCER_ID,
  });

  const envelope = result.body as { ok?: boolean; data?: EventDto; error?: { code: string; message: string } };
  if (result.status !== 200 || !envelope.ok || envelope.data === undefined) {
    throw new Error(`POST /api/events failed (${result.status}): ${envelope.error?.message ?? "unknown error"}`);
  }
  return envelope.data;
}
