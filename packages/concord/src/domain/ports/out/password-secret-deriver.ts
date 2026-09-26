export interface PasswordSecretDeriver {
  derive(password: string, salt: string): Promise<string>;
}
