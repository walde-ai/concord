export interface OpencodeRunnerOptions {
  readonly agentId: string;
  readonly modelId: string;
  readonly runId: string;
  readonly consumerId: string;
  readonly maxInputRounds: number;
  readonly githubToken?: string;
}

export interface OpencodeRunner {
  run(directory: string, prompt: string, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<void>;
  runStructured(directory: string, prompt: string, schema: object, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<unknown>;
}