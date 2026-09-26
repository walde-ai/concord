import { readFileSync } from "node:fs";
import type { LogStoreQuery } from "../../domain/ports/out/log-store";
import type { ParsedArgs } from "../args/argv-parser";
import { userCreateCommand } from "../commands/user-create-command";
import { userDeleteCommand } from "../commands/user-delete-command";
import { eventEmitCommand } from "../commands/event-emit-command";
import {
  contextUpsertCommand,
  readContentValue,
  readSecretsValue,
} from "../commands/context-upsert-command";
import { contextUpsertLocalCommand } from "../commands/context-upsert-local-command";
import {
  peakHoursClearCommand,
  peakHoursGetCommand,
  peakHoursSetCommand,
} from "../commands/peak-hours-command";
import { pauseGetCommand, pauseSetCommand } from "../commands/pause-command";
import { consumerConfigSetCommand } from "../commands/consumer-config-command";
import { consumerSecretSetCommand } from "../commands/consumer-secret-command";
import { consumerOffPeakCommand } from "../commands/consumer-off-peak-command";
import { componentEnabledCommand, type ComponentKind } from "../commands/component-enabled-command";
import { logsQueryCommand } from "../commands/logs-query-command";
import { logsTailCommand } from "../commands/logs-tail-command";
import {
  buildUserCommandDeps,
  resolveApiOrigin,
  resolveDatabasePath,
  resolvePassword,
  resolveUsername,
} from "./compose";
import { buildLocalDeps } from "./local-compose";

/** Handles one `<noun> <verb>` invocation; returns the process exit code. */
export type CommandHandler = (parsed: ParsedArgs) => Promise<number>;

/** Command handlers keyed by `"<noun> <verb>"`. */
export type CommandHandlers = Readonly<Record<string, CommandHandler>>;

export function runCommand(parsed: ParsedArgs, handlers: CommandHandlers): Promise<number> {
  const handler = handlers[`${parsed.noun} ${parsed.verb}`];
  if (handler !== undefined) {
    return handler(parsed);
  }
  return Promise.resolve(reportUnknownCommand(parsed, handlers));
}

function reportUnknownCommand(parsed: ParsedArgs, handlers: CommandHandlers): number {
  process.stderr.write(`concord: unknown command '${parsed.noun} ${parsed.verb}'\n`);
  process.stderr.write("available commands:\n" + formatCommandList(handlers));
  return 2;
}

function formatCommandList(handlers: CommandHandlers): string {
  const lines = Object.keys(handlers)
    .sort()
    .map((key) => `  ${key.replace(" ", " ")}`);
  return `${lines.join("\n")}\n`;
}

export function builtinCommandHandlers(): CommandHandlers {
  return {
    "user create": runUserCreate,
    "user delete": runUserDelete,
    "event emit": runEventEmit,
    "context upsert": runContextUpsert,
    "peak-hours get": runPeakHoursGet,
    "peak-hours set": runPeakHoursSet,
    "peak-hours clear": runPeakHoursClear,
    "pause get": runPauseGet,
    "pause set": runPauseSet,
    "consumer-config set": runConsumerConfigSet,
    "consumer-secret set": runConsumerSecretSet,
    "consumer-secret delete": runConsumerSecretDelete,
    "consumer-off-peak set": runConsumerOffPeak,
    "consumer enable": (parsed) => runComponentEnabled(parsed, "consumer"),
    "consumer disable": (parsed) => runComponentEnabled(parsed, "consumer"),
    "producer enable": (parsed) => runComponentEnabled(parsed, "producer"),
    "producer disable": (parsed) => runComponentEnabled(parsed, "producer"),
    "logs query": runLogsQuery,
    "logs tail": runLogsTail,
  };
}

async function runUserCreate(parsed: ParsedArgs): Promise<number> {
  const name = requireFlag(parsed, "name");
  const password = await resolvePassword(requireFlag(parsed, "password"));
  const deps = buildUserCommandDeps(resolveDatabasePath());
  const descriptor = await userCreateCommand({ name, password, deps });
  process.stdout.write(`${JSON.stringify({ username: descriptor.username })}\n`);
  return 0;
}

async function runUserDelete(parsed: ParsedArgs): Promise<number> {
  const name = requireFlag(parsed, "name");
  const deps = buildUserCommandDeps(resolveDatabasePath());
  const result = await userDeleteCommand({ name, deps });
  process.stdout.write(`${JSON.stringify({ username: result.username })}\n`);
  return 0;
}

async function runEventEmit(parsed: ParsedArgs): Promise<number> {
  const type = requireFlag(parsed, "type");
  const payloadFlag = requireFlag(parsed, "payload");
  const payload = parsePayload(payloadFlag);
  const username = resolveUsername(parsed.flags.username);
  const password = await resolvePassword(parsed.flags.password);
  const origin = resolveApiOrigin();

  const descriptor = await eventEmitCommand({ origin, username, password, type, payload });
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
  return 0;
}

async function runContextUpsert(parsed: ParsedArgs): Promise<number> {
  const name = requireFlag(parsed, "name");
  const contentFlag = requireFlag(parsed, "content");
  const payload = readContentValue(contentFlag);
  const secrets = parsed.flags.secrets !== undefined ? readSecretsValue(parsed.flags.secrets) : {};

  if (parsed.flags.local !== undefined) {
    const descriptor = await contextUpsertLocalCommand({
      deps: buildLocalDeps(),
      name,
      payload,
      secrets,
    });
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
    return 0;
  }

  const username = resolveUsername(parsed.flags.username);
  const password = await resolvePassword(parsed.flags.password);
  const origin = resolveApiOrigin();

  const descriptor = await contextUpsertCommand({ origin, username, password, name, payload, secrets });
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
  return 0;
}

async function runPeakHoursGet(parsed: ParsedArgs): Promise<number> {
  const result = await peakHoursGetCommand({ deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runPeakHoursSet(parsed: ParsedArgs): Promise<number> {
  const start = requireFlag(parsed, "start");
  const end = requireFlag(parsed, "end");
  const timezone = requireFlag(parsed, "timezone");
  assertHHMM("start", start);
  assertHHMM("end", end);
  assertTimezone(timezone);
  const result = await peakHoursSetCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    value: { start, end, timezone },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runPeakHoursClear(parsed: ParsedArgs): Promise<number> {
  await peakHoursClearCommand({ deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)) });
  process.stdout.write(`${JSON.stringify({ cleared: true })}\n`);
  return 0;
}

async function runPauseGet(parsed: ParsedArgs): Promise<number> {
  const result = await pauseGetCommand({ deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runPauseSet(parsed: ParsedArgs): Promise<number> {
  const paused = parseBooleanFlag(parsed, "paused");
  const result = await pauseSetCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    paused,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runConsumerConfigSet(parsed: ParsedArgs): Promise<number> {
  const consumerId = requireFlag(parsed, "id");
  const valuesFlag = requireFlag(parsed, "values");
  const values = readValuesObject(valuesFlag);
  const result = await consumerConfigSetCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    consumerId,
    values,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runConsumerSecretSet(parsed: ParsedArgs): Promise<number> {
  const consumerId = requireFlag(parsed, "id");
  const secretsFlag = requireFlag(parsed, "secrets");
  const upserts = toSecretPairs(readSecretsValue(secretsFlag));
  const result = await consumerSecretSetCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    consumerId,
    operation: { upserts, deletes: [] },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runConsumerSecretDelete(parsed: ParsedArgs): Promise<number> {
  const consumerId = requireFlag(parsed, "id");
  const namesFlag = requireFlag(parsed, "names");
  const deletes = namesFlag.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (deletes.length === 0) {
    process.stderr.write("concord: --names must list at least one secret name (comma-separated)\n");
    process.exit(2);
  }
  const result = await consumerSecretSetCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    consumerId,
    operation: { upserts: [], deletes },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runConsumerOffPeak(parsed: ParsedArgs): Promise<number> {
  const consumerId = requireFlag(parsed, "id");
  const waitForOffPeak = parseBooleanFlag(parsed, "value");
  const result = await consumerOffPeakCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    consumerId,
    waitForOffPeak,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runComponentEnabled(parsed: ParsedArgs, kind: ComponentKind): Promise<number> {
  const id = requireFlag(parsed, "id");
  const enabled = parsed.verb === "enable";
  const result = await componentEnabledCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    kind,
    id,
    enabled,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runLogsQuery(parsed: ParsedArgs): Promise<number> {
  const limit = parsed.flags.limit !== undefined ? Number(parsed.flags.limit) : 50;
  const offset = parsed.flags.offset !== undefined ? Number(parsed.flags.offset) : 0;
  const level = parsed.flags.level;
  const source = parsed.flags.source;
  const text = parsed.flags.text;
  const startTime = parsed.flags.start;
  const endTime = parsed.flags.end;
  const eventId = parsed.flags["event-id"];
  const runId = parsed.flags["run-id"];
  const consumerId = parsed.flags["consumer-id"];
  const result = await logsQueryCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    query: {
      limit,
      offset,
      level: level !== undefined && level.length > 0 ? level as LogStoreQuery["level"] : undefined,
      source: source !== undefined && source.length > 0 ? source : undefined,
      text: text !== undefined && text.length > 0 ? text : undefined,
      startTime: startTime !== undefined && startTime.length > 0 ? startTime : undefined,
      endTime: endTime !== undefined && endTime.length > 0 ? endTime : undefined,
      eventId: eventId !== undefined && eventId.length > 0 ? eventId : undefined,
      runId: runId !== undefined && runId.length > 0 ? runId : undefined,
      consumerId: consumerId !== undefined && consumerId.length > 0 ? consumerId : undefined,
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function runLogsTail(parsed: ParsedArgs): Promise<number> {
  const limit = parsed.flags.limit !== undefined ? Number(parsed.flags.limit) : 100;
  const items = await logsTailCommand({
    deps: buildLocalDeps(resolveDatabasePathFromFlag(parsed)),
    limit,
  });
  for (const entry of items) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  return 0;
}

function resolveDatabasePathFromFlag(parsed: ParsedArgs): string {
  if (parsed.flags.database !== undefined && parsed.flags.database.length > 0) {
    return parsed.flags.database;
  }
  return resolveDatabasePath();
}

/** Reads a required string flag, exiting with usage output when absent. */
export function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`concord: missing required flag --${name}\n`);
    process.exit(2);
  }
  return value;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`concord: --payload must be valid JSON\n`);
    process.exit(2);
  }
}

function parseBooleanFlag(parsed: ParsedArgs, name: string): boolean {
  const value = requireFlag(parsed, name).toLowerCase();
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  process.stderr.write(`concord: --${name} must be "true" or "false"\n`);
  process.exit(2);
}

function readValuesObject(raw: string): Record<string, string> {
  const source = raw.startsWith("@") ? readFile(raw.slice(1), "--values") : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("--values must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--values must be a JSON object of string values");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`--values key "${key}" must be a string`);
    }
    result[key] = value;
  }
  return result;
}

function toSecretPairs(secrets: Readonly<Record<string, string>>): readonly { name: string; value: string }[] {
  return Object.entries(secrets).map(([name, value]) => ({ name, value }));
}

function readFile(path: string, _source: string): string {
  return readFileSync(path, "utf8");
}

function assertHHMM(field: string, value: string): void {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    process.stderr.write(`concord: --${field} must be HH:MM, got: ${value}\n`);
    process.exit(2);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    process.stderr.write(`concord: --${field} is out of range: ${value}\n`);
    process.exit(2);
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    process.stderr.write(`concord: --timezone is not a valid IANA timezone: ${timezone}\n`);
    process.exit(2);
  }
}
