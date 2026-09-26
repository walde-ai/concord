export class Credential {
  public constructor(
    public readonly username: string,
    public readonly salt: string,
    public readonly verifier: string,
  ) {}
}
