import { createChatCompletion } from "./services/groq-client";

async function main() {
  const result = await createChatCompletion("מה זה חמצן?");
  console.log(result);
}

main();
