import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { Run } from "../src/domain/entities/run";
import { Event } from "../src/domain/entities/event";
import type { Event as EventType } from "../src/domain/entities/event";
import { failure } from "../src/domain/result";
import type { Result } from "../src/domain/result";
import { noopLogger, type Logger } from "../src/domain/ports/out/logger";
import type { ConsumerConfigValues, ConsumerConfigSecrets } from "../src/domain/component";
import type { ConsumerConfigResolver } from "../src/domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../src/domain/ports/out/consumer-secret-resolver";
import { RUN_INPUT_REQUESTED, type RunInputRequestedPayload } from "../src/domain/events/run-input-event";

import { TelegramNotifierRule } from "../src/infra/adapters/consumers/telegram/telegram-notifier-rule";
import { TelegramNotifierHandler } from "../src/infra/adapters/consumers/telegram/telegram-notifier-handler";
import { TelegramNotifierConsumer } from "../src/infra/adapters/consumers/telegram/telegram-notifier-consumer";
import { TelegramBotClient, type TelegramClient, type SendMessageRequest } from "../src/infra/adapters/consumers/telegram/telegram-client";
import {
  TELEGRAM_NOTIFIER_CONSUMER_ID,
  TELEGRAM_NOTIFIER_CONFIG_SCHEMA,
  TELEGRAM_NOTIFIER_SECRET,
} from "../src/infra/adapters/consumers/telegram/telegram-config-schema";
import { RegistrationContext } from "../src/infra/main/registration-context";
import { SequentialIdGenerator, FixedClock } from "./helpers";
import type { ContextResolver, ContextRequester, ContextGuard, ResolvedContext } from "../src/domain/ports/out/context-resolver";
import { ContextResolveError as ContextResolveErrorClass, type ContextResolveError } from "../src/domain/exceptions/errors";

class StubContextResolver implements ContextResolver {
  public async resolve<T>(
    _requester: ContextRequester,
    name: string,
    _guard: ContextGuard<T>,
  ): Promise<Result<ResolvedContext<T>, ContextResolveError>> {
    return failure<ResolvedContext<T>, ContextResolveError>(
      new ContextResolveErrorClass(name, "NOT_FOUND"),
    );
  }
}

class RecordingTelegramClient implements TelegramClient {
  public readonly calls: SendMessageRequest[] = [];
  private shouldThrow: Error | null = null;

  public willThrow(error: Error): void {
    this.shouldThrow = error;
  }

  public async sendMessage(request: SendMessageRequest): Promise<void> {
    this.calls.push(request);
    if (this.shouldThrow !== null) {
      throw this.shouldThrow;
    }
  }
}

class FakeConfigResolver implements ConsumerConfigResolver {
  public constructor(private readonly values: ConsumerConfigValues = {}) {}

  public async resolve(_consumerId: string): Promise<ConsumerConfigValues> {
    return { ...this.values };
  }
}

class FakeSecretResolver implements ConsumerSecretResolver {
  public constructor(private readonly secrets: ConsumerConfigSecrets = {}) {}

  public async resolveSecrets(_consumerId: string): Promise<ConsumerConfigSecrets> {
    return { ...this.secrets };
  }
}

class RecordingLogger implements Logger {
  public readonly warnings: Array<{ source: string; message: string }> = [];

  public log(): void {}
  public debug(): void {}
  public info(): void {}
  public warn(source: string, message: string): void {
    this.warnings.push({ source, message });
  }
  public error(): void {}
}

function inputRequestedPayload(overrides: Partial<RunInputRequestedPayload> = {}): RunInputRequestedPayload {
  return {
    runId: "abc-123",
    consumerId: "worker-b",
    formId: "form-1",
    round: 1,
    prompt: "Should I merge this PR?",
    fields: [],
    ...overrides,
  };
}

function runFor(payload: unknown, consumerId = TELEGRAM_NOTIFIER_CONSUMER_ID): Run<unknown> {
  const event = new Event<unknown>(
    "evt-1",
    "concord.run-input",
    "pevt-1",
    new Date("2026-07-11T00:00:00Z"),
    RUN_INPUT_REQUESTED,
    payload,
  );
  return new Run<unknown>("run-1", event, consumerId);
}

function event(type: string): EventType<unknown> {
  return new Event<unknown>("id", "p", "p", new Date(), type, {});
}

const DEFAULT_CONFIG: ConsumerConfigValues = {
  chatId: "-1001234567890",
  uiBaseUrl: "http://localhost:5173",
  notifyRunInputRequested: "true",
};

const DEFAULT_SECRETS: ConsumerConfigSecrets = {
  botToken: "123456:ABC-DEF",
};

function buildHandler(
  client: RecordingTelegramClient,
  config: ConsumerConfigValues = DEFAULT_CONFIG,
  secrets: ConsumerConfigSecrets = DEFAULT_SECRETS,
  logger: Logger = noopLogger,
): TelegramNotifierHandler {
  return new TelegramNotifierHandler(
    new FakeConfigResolver(config),
    new FakeSecretResolver(secrets),
    logger,
    client,
  );
}

describe("TelegramNotifierRule", () => {
  const rule = new TelegramNotifierRule();

  it("matches run.input_requested", () => {
    expect(rule.decide(event(RUN_INPUT_REQUESTED))).toBe(true);
  });

  it("does not match pr.opened", () => {
    expect(rule.decide(event("pr.opened"))).toBe(false);
  });

  it("does not match pipeline.failed", () => {
    expect(rule.decide(event("pipeline.failed"))).toBe(false);
  });

  it("does not match rawjson", () => {
    expect(rule.decide(event("rawjson"))).toBe(false);
  });
});

describe("TelegramNotifierHandler", () => {
  it("sends a message with full configuration", async () => {
    const client = new RecordingTelegramClient();
    const handler = buildHandler(client);

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call.botToken).toBe("123456:ABC-DEF");
    expect(call.chatId).toBe("-1001234567890");
    expect(call.parseMode).toBe("HTML");
    expect(call.text).toBe('<b>worker-b</b> needs input: <a href="http://localhost:5173/runs/abc-123">open run</a>');
  });

  it("skips when notifyRunInputRequested is false", async () => {
    const client = new RecordingTelegramClient();
    const handler = buildHandler(client, { ...DEFAULT_CONFIG, notifyRunInputRequested: "false" });

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("skips and warns when chatId is empty", async () => {
    const client = new RecordingTelegramClient();
    const logger = new RecordingLogger();
    const handler = buildHandler(client, { ...DEFAULT_CONFIG, chatId: "" }, DEFAULT_SECRETS, logger);

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(logger.warnings).toHaveLength(1);
  });

  it("skips and warns when uiBaseUrl is empty", async () => {
    const client = new RecordingTelegramClient();
    const logger = new RecordingLogger();
    const handler = buildHandler(client, { ...DEFAULT_CONFIG, uiBaseUrl: "" }, DEFAULT_SECRETS, logger);

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(logger.warnings).toHaveLength(1);
  });

  it("skips and warns when botToken is empty", async () => {
    const client = new RecordingTelegramClient();
    const logger = new RecordingLogger();
    const handler = buildHandler(client, DEFAULT_CONFIG, { botToken: "" }, logger);

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(logger.warnings).toHaveLength(1);
  });

  it("returns failure when the Telegram client throws", async () => {
    const client = new RecordingTelegramClient();
    client.willThrow(new Error("400: Bad Request: chat not found"));
    const handler = buildHandler(client);

    const result = await handler.handle(runFor(inputRequestedPayload()), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("400: Bad Request: chat not found");
    }
  });
});

describe("TelegramBotClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return {
      status,
      json: () => Promise.resolve(body),
    } as Response;
  }

  it("sends a POST to the correct URL with the right body", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ ok: true, result: {} })),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new TelegramBotClient();
    await client.sendMessage({
      botToken: "123456:ABC",
      chatId: "-1001234567890",
      text: "<b>worker-b</b> needs input: <a href=\"http://localhost:5173/runs/abc-123\">open run</a>",
      parseMode: "HTML",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123456:ABC/sendMessage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(init?.body as string);
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.text).toBe("<b>worker-b</b> needs input: <a href=\"http://localhost:5173/runs/abc-123\">open run</a>");
    expect(body.parse_mode).toBe("HTML");
    expect(body.disable_web_page_preview).toBe(true);
  });

  it("resolves when response ok is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: {} })) as unknown as typeof globalThis.fetch;

    const client = new TelegramBotClient();
    await expect(
      client.sendMessage({ botToken: "tok", chatId: "chat", text: "hello", parseMode: "HTML" }),
    ).resolves.toBeUndefined();
  });

  it("throws when response ok is false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    ) as unknown as typeof globalThis.fetch;

    const client = new TelegramBotClient();
    await expect(
      client.sendMessage({ botToken: "tok", chatId: "chat", text: "hello", parseMode: "HTML" }),
    ).rejects.toThrow("400: Bad Request: chat not found");
  });

  it("throws generic message when description is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 500 }),
    ) as unknown as typeof globalThis.fetch;

    const client = new TelegramBotClient();
    await expect(
      client.sendMessage({ botToken: "tok", chatId: "chat", text: "hello", parseMode: "HTML" }),
    ).rejects.toThrow("500: Telegram API error");
  });

  it("propagates fetch rejection", async () => {
    const networkError = new Error("fetch failed");
    globalThis.fetch = vi.fn().mockRejectedValue(networkError) as unknown as typeof globalThis.fetch;

    const client = new TelegramBotClient();
    await expect(
      client.sendMessage({ botToken: "tok", chatId: "chat", text: "hello", parseMode: "HTML" }),
    ).rejects.toThrow("fetch failed");
  });
});

describe("TelegramNotifierConsumer", () => {
  it("registers a consumer with the correct id, schemas, and rule", () => {
    const client = new RecordingTelegramClient();
    const consumer = new TelegramNotifierConsumer(
      new FakeConfigResolver(),
      new FakeSecretResolver(),
      noopLogger,
      client,
    );

    const registration = new RegistrationContext(
      new SequentialIdGenerator(),
      new FixedClock(new Date("2026-07-11T00:00:00Z")),
      new StubContextResolver(),
    );
    consumer.register(registration);

    expect(registration.consumers).toHaveLength(1);
    const registered = registration.consumers[0];
    expect(registered.consumerId).toBe(TELEGRAM_NOTIFIER_CONSUMER_ID);
    expect(registered.configSchema).toBe(TELEGRAM_NOTIFIER_CONFIG_SCHEMA);
    expect(registered.secretSchema).toBe(TELEGRAM_NOTIFIER_SECRET);
    expect(registered.rule.decide(event(RUN_INPUT_REQUESTED))).toBe(true);
    expect(registered.rule.decide(event("pr.opened"))).toBe(false);
  });
});
