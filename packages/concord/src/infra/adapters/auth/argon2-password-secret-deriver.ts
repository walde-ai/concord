import { hash, argon2id } from "argon2";
import type { PasswordSecretDeriver } from "../../../domain/ports/out/password-secret-deriver";

export interface Argon2Parameters {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const OWASP_ARGON2ID_PARAMETERS: Argon2Parameters = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const TEST_ARGON2ID_PARAMETERS: Argon2Parameters = {
  memoryCost: 256,
  timeCost: 1,
  parallelism: 1,
};

export class Argon2PasswordSecretDeriver implements PasswordSecretDeriver {
  public constructor(private readonly params: Argon2Parameters) {}

  public async derive(password: string, salt: string): Promise<string> {
    const saltBytes = Buffer.from(salt, "hex");
    const digest = await hash(password, {
      type: argon2id,
      salt: saltBytes,
      hashLength: 32,
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
      raw: true,
    });
    return Buffer.from(digest).toString("hex");
  }
}
