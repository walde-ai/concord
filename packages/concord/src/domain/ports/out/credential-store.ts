import type { Credential } from "../../entities/credential";
import type { Result } from "../../result";
import type { ConcordError } from "../../exceptions/errors";

export interface CredentialStore {
  getByName(username: string): Promise<Credential>;
  exists(username: string): Promise<boolean>;
  save(credential: Credential): Promise<Result<void, ConcordError>>;
  delete(username: string): Promise<Result<void, ConcordError>>;
}
