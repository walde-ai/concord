export interface BeginLoginResult {
  readonly salt: string;
  readonly serverPublicEphemeral: string;
  readonly handshakeId: string;
}

export interface BeginLogin {
  begin(username: string, clientPublicEphemeral: string): Promise<BeginLoginResult>;
}
