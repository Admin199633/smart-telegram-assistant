import { createGeminiCompletion } from "./gemini-client.js";
import { createChatCompletion } from "./groq-client.js";

const ERROR_RESPONSE = "מצטער, הייתה בעיה זמנית. נסה שוב.";

export async function createSmartChatCompletion(input: string): Promise<string> {
  try {
    const result = await createGeminiCompletion(input);

    if (result === ERROR_RESPONSE) {
      return createChatCompletion(input);
    }

    return result;
  } catch {
    return createChatCompletion(input);
  }
}