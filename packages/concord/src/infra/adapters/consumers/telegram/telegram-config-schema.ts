import type { ConsumerConfigParameter, ConsumerConfigSecretParameter } from "../../../../domain/component";

export const TELEGRAM_NOTIFIER_CONSUMER_ID = "telegram-notifier";

export const TELEGRAM_NOTIFIER_CONFIG_SCHEMA: readonly ConsumerConfigParameter[] = [
  { key: "chatId", label: "Chat ID", required: true, defaultValue: "" },
  { key: "uiBaseUrl", label: "UI base URL", required: true, defaultValue: "" },
  { key: "notifyRunInputRequested", label: "Notify on run.input_requested", required: true, defaultValue: "true" },
];

export const TELEGRAM_NOTIFIER_SECRET: readonly ConsumerConfigSecretParameter[] = [
  { key: "botToken", label: "Bot token" },
];
