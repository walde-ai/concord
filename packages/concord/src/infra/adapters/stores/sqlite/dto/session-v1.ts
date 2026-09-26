export class SessionV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly username: string,
    public readonly sessionKey: string,
    public readonly expiresAt: Date,
  ) {}

  public toRow(): { username: string; session_key: string; expires_at: string } {
    return {
      username: this.username,
      session_key: this.sessionKey,
      expires_at: this.expiresAt.toISOString(),
    };
  }

  public static fromRow(id: string, username: string, sessionKey: string, expiresAt: string): SessionV1 {
    return new SessionV1(id, username, sessionKey, new Date(expiresAt));
  }
}
