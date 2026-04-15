import { createGeminiCompletion } from "./gemini-client.js";
import { createChatCompletion } from "./groq-client.js";
import { logger } from "../utils/logger.js";

const ERROR_RESPONSE = "מצטער, הייתה בעיה זמנית. נסה שוב.";
const GROQ_FAILURE_RESPONSE = "מצטער, גם המנוע החלופי לא הצליח לעזור. נסה שוב מאוחר יותר.";

export const PRIMARY_ENGINE_ESCALATION_PROMPT = "אני לא יכול לעזור עם זה, אבל רוצה שאנסה מנוע אחר?";

export type ModelOutcome =
  | { kind: "success"; text: string }
  | { kind: "technical_failure"; reason: string }
  | { kind: "refusal"; reason: string };

const REFUSAL_PATTERNS = [
  /I (?:can'?t|cannot|am unable to|'m not able to)/i,
  /I'?m not (?:able|designed|programmed) to/i,
  /(?:against|violates?) (?:my )?(?:policy|guidelines|terms)/i,
  /(?:safety|content) (?:policy|filter|guidelines)/i,
  /אני לא (?:יכול|מסוגל|מורשה)/,
  /לא (?:אוכל|ניתן) לעזור/,
  /אין באפשרותי/,
  /חורג מההנחיות/
];

function classifyGeminiResponse(text: string): ModelOutcome {
  const normalized = text.trim();

  if (!normalized) {
    return { kind: "technical_failure", reason: "empty response" };
  }

  if (normalized === ERROR_RESPONSE) {
    return { kind: "technical_failure", reason: "invalid response" };
  }

  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { kind: "refusal", reason: "policy or safety refusal detected" };
    }
  }

  return { kind: "success", text: normalized };
}

function classifyGeminiFailureReason(error: unknown): string {
  const message = String(error ?? "").toLowerCase();

  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) {
    return "timeout";
  }

  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("socket") ||
    message.includes("econn") ||
    message.includes("enotfound")
  ) {
    return "network error";
  }

  if (message.includes("parse") || message.includes("json")) {
    return "parse failure";
  }

  if (message.includes("invalid")) {
    return "invalid response";
  }

  return "technical failure";
}

export async function fallbackToGroq(input: string): Promise<string> {
  try {
    const result = await createChatCompletion(input);
    if (!result || result === ERROR_RESPONSE) {
      return GROQ_FAILURE_RESPONSE;
    }
    return result;
  } catch {
    return GROQ_FAILURE_RESPONSE;
  }
}

export async function getGeminiOutcome(input: string): Promise<ModelOutcome> {
  try {
    const result = await createGeminiCompletion(input);
    return classifyGeminiResponse(result);
  } catch (err) {
    return { kind: "technical_failure", reason: classifyGeminiFailureReason(err) };
  }
}

export async function createSmartChatCompletion(input: string): Promise<string> {
  const outcome = await getGeminiOutcome(input);

  if (outcome.kind === "success") {
    logger.info("smart-chat: Gemini success");
    return outcome.text;
  }

  if (outcome.kind === "technical_failure") {
    logger.info("smart-chat: Gemini technical failure, falling back to Groq", { reason: outcome.reason });
    return fallbackToGroq(input);
  }

  logger.info("smart-chat: Gemini refusal, escalation required", { reason: outcome.reason });
  return PRIMARY_ENGINE_ESCALATION_PROMPT;
}

export async function escalateToGroq(input: string): Promise<string> {
  logger.info("smart-chat: escalating to Groq by user request");
  const result = await fallbackToGroq(input);
  if (result === GROQ_FAILURE_RESPONSE) {
    logger.info("smart-chat: Groq escalation failed");
    return result;
  }
  logger.info("smart-chat: Groq escalation succeeded");
  return result;
}
