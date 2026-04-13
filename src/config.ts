import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:3000/oauth/google/callback"),
  APP_ACTIONS_API_KEYS: z.string().default("{}"),
  PORT: z.coerce.number().default(3000),
  DEFAULT_TIMEZONE: z.string().default("Asia/Jerusalem"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000")
});

const env = envSchema.parse(process.env);

export const config = {
  openAiApiKey: env.OPENAI_API_KEY,
  openAiModel: env.OPENAI_MODEL,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  databaseUrl: env.DATABASE_URL,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: env.GOOGLE_REDIRECT_URI,
  appActionApiKeys: safeJsonParse<Record<string, string>>(env.APP_ACTIONS_API_KEYS, {}),
  port: env.PORT,
  defaultTimezone: env.DEFAULT_TIMEZONE,
  publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, "")
};

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
