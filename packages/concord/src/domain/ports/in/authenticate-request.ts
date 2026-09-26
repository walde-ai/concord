import type { SignedRequest } from "../../ports/out/signed-request";

export interface AuthenticateRequest {
  authenticate(request: SignedRequest): Promise<string>;
}
