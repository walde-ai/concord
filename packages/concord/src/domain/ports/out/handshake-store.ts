export interface StoredHandshake {
  readonly serverSecret: string;
  readonly clientPublicEphemeral: string;
  readonly username: string;
  readonly fake: boolean;
}

export interface HandshakeStore {
  put(id: string, payload: StoredHandshake): Promise<void>;
  take(id: string): Promise<StoredHandshake>;
}
