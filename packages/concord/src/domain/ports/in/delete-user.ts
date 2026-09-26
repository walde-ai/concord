export interface DeleteUser {
  delete(username: string): Promise<void>;
}
