import type { Registrable } from "../../../../domain/ports/in/registrable";
import type { Registration } from "../../../../domain/ports/in/registration";
import type { Logger } from "../../../../domain/ports/out/logger";
import type { ConsumerConfigResolver } from "../../../../domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../../../../domain/ports/out/consumer-secret-resolver";
import { Consumer } from "../../../../domain/entities/consumer";

import type { TelegramClient } from "./telegram-client";
import { TELEGRAM_NOTIFIER_CONSUMER_ID, TELEGRAM_NOTIFIER_CONFIG_SCHEMA, TELEGRAM_NOTIFIER_SECRET } from "./telegram-config-schema";
import { TelegramNotifierRule } from "./telegram-notifier-rule";
import { TelegramNotifierHandler } from "./telegram-notifier-handler";

export class TelegramNotifierConsumer implements Registrable {
  public constructor(
    private readonly configResolver: ConsumerConfigResolver,
    private readonly secretResolver: ConsumerSecretResolver,
    private readonly logger: Logger,
    private readonly telegramClient: TelegramClient,
  ) {}

  public register(registration: Registration): void {
    const rule = new TelegramNotifierRule();
    const handler = new TelegramNotifierHandler(
      this.configResolver,
      this.secretResolver,
      this.logger,
      this.telegramClient,
    );
    registration.addConsumer(
      new Consumer<unknown>(
        TELEGRAM_NOTIFIER_CONSUMER_ID,
        rule,
        handler,
        TELEGRAM_NOTIFIER_CONFIG_SCHEMA,
        TELEGRAM_NOTIFIER_SECRET,
      ),
    );
  }
}
