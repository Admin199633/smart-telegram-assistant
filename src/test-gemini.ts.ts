import { createGeminiCompletion } from "./services/gemini-client";

async function main() {
  const result = await createGeminiCompletion("מה זה חמצן?");
  console.log(result);
}

main();