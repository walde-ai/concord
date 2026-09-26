export interface DeleteContext {
  delete(name: string): Promise<void>;
}
