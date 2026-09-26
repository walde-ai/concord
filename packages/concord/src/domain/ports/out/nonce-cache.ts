export interface NonceCache {
  saw(nonce: string, timestamp: number): Promise<boolean>;
}
