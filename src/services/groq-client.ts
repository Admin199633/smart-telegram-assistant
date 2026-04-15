const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const SYSTEM_PROMPT = `You are a helpful and reliable personal assistant.

Always respond in Hebrew.

Rules:
- Keep answers short and clear
- Be accurate and avoid guessing
- If you are unsure, say you are not sure
- Use simple, natural Hebrew
- Do not invent facts

Do NOT:
- Suggest actions unless explicitly asked
- Execute any actions

Answer like a smart human assistant, not like a textbook.`;
const ERROR_RESPONSE = "מצטער, הייתה בעיה זמנית. נסה שוב.";

export async function createChatCompletion(input: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  console.log("[debug] GROQ_API_KEY exists:", !!apiKey);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log("[debug] response.status:", response.status);
      console.log("[debug] response.text:", text);
      return ERROR_RESPONSE;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? ERROR_RESPONSE;
  } catch (err) {
    console.log("[debug] caught error:", err);
    return ERROR_RESPONSE;
  }
}
