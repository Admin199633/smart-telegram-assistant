import { config } from "../config.js";

export class TelegramService {
  async setWebhook(url: string): Promise<Record<string, unknown>> {
    if (!config.telegramBotToken) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        secret_token: config.telegramWebhookSecret
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram setWebhook failed: ${response.status} ${body}`);
    }

    return await response.json() as Record<string, unknown>;
  }

  async getWebhookInfo(): Promise<Record<string, unknown>> {
    if (!config.telegramBotToken) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getWebhookInfo`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram getWebhookInfo failed: ${response.status} ${body}`);
    }
    return await response.json() as Record<string, unknown>;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!config.telegramBotToken) {
      return;
    }

    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/answerCallbackQuery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${body}`);
    }
  }

  async sendMessage(chatId: number, text: string, replyMarkup?: Record<string, unknown>, parseMode?: "HTML" | "MarkdownV2"): Promise<void> {
    if (!config.telegramBotToken) {
      return;
    }

    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        reply_markup: replyMarkup
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
  }
}
