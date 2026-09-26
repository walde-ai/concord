export interface IssuedCredential {
  readonly salt: string;
  readonly verifier: string;
}

export interface CredentialIssuer {
  generate(username: string, password: string): Promise<IssuedCredential>;
}
