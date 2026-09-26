export interface SessionValue {
  readonly username: string;
  readonly sessionKey: string;
  readonly expiresAt: Date;
}

export interface SessionStore {
  create(value: SessionValue): Promise<string>;
  get(id: string): Promise<SessionValue>;
  touch(id: string, expiresAt: Date): Promise<void>;
}
