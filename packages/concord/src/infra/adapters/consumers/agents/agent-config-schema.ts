import type { ConsumerConfigParameter, ConsumerConfigSecretParameter } from "../../../../domain/component";
import { DEFAULT_RUN_TIMEOUT_MS } from "../../../../domain/ports/out/run-timeout-resolver";

export const AGENT_CONSUMER_CONFIG_SCHEMA: readonly ConsumerConfigParameter[] = [
  { key: "modelId", label: "Model", required: true, defaultValue: "" },
  { key: "agentName", label: "Agent", required: true, defaultValue: "" },
  { key: "maxInputRounds", label: "Max input rounds", required: true, defaultValue: "0" },
  { key: "runTimeoutMs", label: "Run timeout (ms)", required: true, defaultValue: String(DEFAULT_RUN_TIMEOUT_MS) },
];

export const AGENT_GITHUB_TOKEN_SECRET: readonly ConsumerConfigSecretParameter[] = [
  { key: "githubToken", label: "GitHub token" },
];
