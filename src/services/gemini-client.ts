const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent";

const ERROR_RESPONSE = "מצטער, הייתה בעיה זמנית. נסה שוב.";

const SYSTEM_PROMPT = `You are a personal assistant.
You respond in Hebrew.
Keep answers short, clear, and helpful.
Do not suggest actions unless explicitly asked.
Do not execute any actions.
If unsure, say you are not sure.`;

export async function createGeminiCompletion(input: string): Promise<string> {
  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `${SYSTEM_PROMPT}\n\nUser: ${input}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.log("[gemini] status:", response.status);
      console.log("[gemini] body:", text);
      return ERROR_RESPONSE;
    }

    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ERROR_RESPONSE;
  } catch (err) {
    console.log("[gemini] error:", err);
    return ERROR_RESPONSE;
  }
}