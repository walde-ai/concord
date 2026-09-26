import type { AnswerMap } from "../../entities/run-form";

export interface RunInputHandle {
  readonly promise: Promise<AnswerMap>;
  resolve(answers: AnswerMap): void;
  reject(cause: unknown): void;
}

export interface RunInputRegistry {
  register(runId: string, handle: RunInputHandle): void;
  lookup(runId: string): RunInputHandle | null;
  unregister(runId: string): void;
}
