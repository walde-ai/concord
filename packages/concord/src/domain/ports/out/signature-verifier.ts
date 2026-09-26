export interface SignatureVerifier {
  verify(key: string, message: string, signature: string): boolean;
}
