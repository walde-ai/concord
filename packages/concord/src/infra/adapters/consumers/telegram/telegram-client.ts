export interface SendMessageRequest {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly parseMode: string;
}

export interface TelegramClient {
  sendMessage(request: SendMessageRequest): Promise<void>;
}

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const SEND_MESSAGE_PATH = "/sendMessage";

interface TelegramSendResponse {
  readonly ok: boolean;
  readonly error_code?: number;
  readonly description?: string;
}

export class TelegramBotClient implements TelegramClient {
  public async sendMessage(request: SendMessageRequest): Promise<void> {
    const url = `${TELEGRAM_API_BASE}${request.botToken}${SEND_MESSAGE_PATH}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: request.chatId,
        text: request.text,
        parse_mode: request.parseMode,
        disable_web_page_preview: true,
      }),
    });
    const body = (await response.json()) as TelegramSendResponse;
    if (body.ok) {
      return;
    }
    const description = body.description ?? "Telegram API error";
    if (body.error_code !== undefined) {
      throw new Error(`${body.error_code}: ${description}`);
    }
    throw new Error(description);
  }
}
