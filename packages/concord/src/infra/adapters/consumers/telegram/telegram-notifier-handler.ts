import type { Handler } from "../../../../domain/ports/out/handler";
import type { Run } from "../../../../domain/entities/run";
import type { Result } from "../../../../domain/result";
import { success, failure } from "../../../../domain/result";
import { EventHandlerError } from "../../../../domain/exceptions/errors";
import type { Logger } from "../../../../domain/ports/out/logger";
import type { ConsumerConfigResolver } from "../../../../domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../../../../domain/ports/out/consumer-secret-resolver";
import type { RunInputRequestedPayload } from "../../../../domain/events/run-input-event";
import type { TelegramClient } from "./telegram-client";

const SOURCE = "telegram-notifier-handler";
const HTML_PARSE_MODE = "HTML";
const NOTIFY_FLAG_KEY = "notifyRunInputRequested";
const CHAT_ID_KEY = "chatId";
const UI_BASE_URL_KEY = "uiBaseUrl";
const BOT_TOKEN_KEY = "botToken";

export class TelegramNotifierHandler implements Handler<unknown> {
  public constructor(
    private readonly configResolver: ConsumerConfigResolver,
    private readonly secretResolver: ConsumerSecretResolver,
    private readonly logger: Logger,
    private readonly telegramClient: TelegramClient,
  ) {}

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    const payload = run.event.payload as RunInputRequestedPayload;
    const config = await this.configResolver.resolve(run.consumerId);

    if (config[NOTIFY_FLAG_KEY] === "false") {
      return success(undefined);
    }

    const chatId = config[CHAT_ID_KEY] ?? "";
    const uiBaseUrl = config[UI_BASE_URL_KEY] ?? "";
    if (chatId.length === 0 || uiBaseUrl.length === 0) {
      this.logger.warn(SOURCE, "missing configuration, skipping notification", {
        consumerId: run.consumerId,
        chatIdEmpty: chatId.length === 0,
        uiBaseUrlEmpty: uiBaseUrl.length === 0,
      });
      return success(undefined);
    }

    const secrets = await this.secretResolver.resolveSecrets(run.consumerId);
    const botToken = secrets[BOT_TOKEN_KEY] ?? "";
    if (botToken.length === 0) {
      this.logger.warn(SOURCE, "missing bot token, skipping notification", {
        consumerId: run.consumerId,
      });
      return success(undefined);
    }

    const runLink = `${uiBaseUrl}/runs/${payload.runId}`;
    const text = `<b>${payload.consumerId}</b> needs input: <a href="${runLink}">open run</a>`;

    try {
      await this.telegramClient.sendMessage({
        botToken,
        chatId,
        text,
        parseMode: HTML_PARSE_MODE,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(new EventHandlerError(message));
    }
    return success(undefined);
  }
}
