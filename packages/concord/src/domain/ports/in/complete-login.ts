export interface CompleteLoginResult {
  readonly sessionId: string;
  readonly username: string;
  readonly serverSessionProof: string;
}

export interface CompleteLogin {
  complete(handshakeId: string, clientPublicEphemeral: string, clientSessionProof: string): Promise<CompleteLoginResult>;
}
