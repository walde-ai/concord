import { describe, it, expect } from "vitest";
import * as srpClient from "secure-remote-password/client";

import { Credential } from "../src/domain/entities/credential";
import { InvalidProofError } from "../src/domain/exceptions/errors";
import { InMemoryCredentialStore } from "../src/infra/adapters/stores/in-memory-credential-store";
import {
  Argon2PasswordSecretDeriver,
  TEST_ARGON2ID_PARAMETERS,
} from "../src/infra/adapters/auth/argon2-password-secret-deriver";
import { SecureRemotePasswordIssuer } from "../src/infra/adapters/auth/secure-remote-password-issuer";
import { SecureRemotePasswordHandshake } from "../src/infra/adapters/auth/secure-remote-password-handshake";

const PEPPER = "test-pepper";

function buildClientDigest(
  deriver: Argon2PasswordSecretDeriver,
  password: string,
  salt: string,
): Promise<string> {
  return deriver.derive(password, salt);
}

async function performFullLogin(
  deriver: Argon2PasswordSecretDeriver,
  issuer: SecureRemotePasswordIssuer,
  handshake: SecureRemotePasswordHandshake,
  store: InMemoryCredentialStore,
  username: string,
  password: string,
): Promise<{ clientSessionKey: string; serverSessionKey: string; serverSessionProof: string }> {
  const credential = await store.getByName(username);

  const clientEphemeral = srpClient.generateEphemeral();
  const begun = await handshake.begin(clientEphemeral.public, credential);

  const digest = await buildClientDigest(deriver, password, credential.salt);
  const privateKey = srpClient.derivePrivateKey(credential.salt, username, digest);
  const clientSession = srpClient.deriveSession(
    clientEphemeral.secret,
    begun.serverPublicEphemeral,
    credential.salt,
    username,
    privateKey,
  );

  const completed = await handshake.complete(
    begun.serverSecret,
    clientEphemeral.public,
    credential,
    clientSession.proof,
  );

  return {
    clientSessionKey: clientSession.key,
    serverSessionKey: completed.sessionKey,
    serverSessionProof: completed.serverSessionProof,
  };
}

describe("Argon2id into SRP composition", () => {
  it("registers a user, runs the full server-side handshake, and derives matching session keys", async () => {
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const handshake = new SecureRemotePasswordHandshake(PEPPER);
    const store = new InMemoryCredentialStore();

    const issued = await issuer.generate("alice", "super-secret-password");
    await store.save(new Credential("alice", issued.salt, issued.verifier));

    const { clientSessionKey, serverSessionKey, serverSessionProof } = await performFullLogin(
      deriver,
      issuer,
      handshake,
      store,
      "alice",
      "super-secret-password",
    );

    expect(clientSessionKey).toBe(serverSessionKey);
    expect(serverSessionProof).toHaveLength(64);
  });

  it("throws InvalidProofError when the client proof is tampered", async () => {
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const handshake = new SecureRemotePasswordHandshake(PEPPER);
    const store = new InMemoryCredentialStore();

    const issued = await issuer.generate("alice", "super-secret-password");
    await store.save(new Credential("alice", issued.salt, issued.verifier));
    const credential = await store.getByName("alice");

    const clientEphemeral = srpClient.generateEphemeral();
    const begun = await handshake.begin(clientEphemeral.public, credential);

    await expect(
      handshake.complete(begun.serverSecret, clientEphemeral.public, credential, "deadbeef".repeat(16)),
    ).rejects.toBeInstanceOf(InvalidProofError);
  });

  it("fails login when the password is wrong", async () => {
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const handshake = new SecureRemotePasswordHandshake(PEPPER);
    const store = new InMemoryCredentialStore();

    const issued = await issuer.generate("alice", "correct-password");
    await store.save(new Credential("alice", issued.salt, issued.verifier));

    await expect(
      performFullLogin(deriver, issuer, handshake, store, "alice", "wrong-password"),
    ).rejects.toBeInstanceOf(InvalidProofError);
  });

  it("produces a plausible salt and ephemeral of the right shape for an unknown user via beginFake", async () => {
    const handshake = new SecureRemotePasswordHandshake(PEPPER);

    const fake = await handshake.beginFake("ghost", "some-client-ephemeral");

    expect(fake.salt).toHaveLength(32);
    expect(fake.serverPublicEphemeral).toHaveLength(512);

    const fakeAgain = await handshake.beginFake("ghost", "some-client-ephemeral");
    expect(fakeAgain.salt).toBe(fake.salt);
    expect(fakeAgain.serverPublicEphemeral).toBe(fake.serverPublicEphemeral);

    const otherUser = await handshake.beginFake("other", "some-client-ephemeral");
    expect(otherUser.salt).not.toBe(fake.salt);
  });
});
