export interface Closeable {
  close(): Promise<void>;
}
