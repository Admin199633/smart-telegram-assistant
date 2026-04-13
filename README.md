# Smart Telegram Bot v1

Product specification in Hebrew: [`docs/PROJECT_SPEC_HE.md`](./docs/PROJECT_SPEC_HE.md)

Backend skeleton for a Hebrew-first Telegram bot that can:

- Draft personal and business messages
- Interpret meeting requests in natural language
- Ask for confirmation before running external actions
- Connect to Google Calendar and app-defined action endpoints

## Quick start

1. Copy `.env.example` to `.env`
2. Fill in your Telegram, OpenAI and Google credentials
   Also set `PUBLIC_BASE_URL` to the public HTTPS URL that Telegram and Google can reach.
3. Install dependencies:

```bash
npm install
```

4. Run locally:

```bash
npm run dev
```

5. Build and test:

```bash
npm run build
npm test
```

6. Connect Telegram webhook:

```bash
curl -X POST http://localhost:3001/telegram/setup-webhook
```

7. Connect Google Calendar for a Telegram user:

```bash
open "https://aerostatic-eladia-holstered.ngrok-free.dev/oauth/google/start?userId=123456&chatId=123456"
```

This route now redirects directly to Google OAuth.
If you need the raw authorization URL as JSON for debugging, use:

```bash
curl "https://aerostatic-eladia-holstered.ngrok-free.dev/oauth/google/start?userId=123456&chatId=123456&mode=json"
```

## Main endpoints

- `POST /telegram/webhook`
- `POST /agent/interpret`
- `POST /agent/confirm`
- `POST /integrations/calendar/create-event`
- `POST /integrations/apps/:appKey/:actionName`
- `GET /oauth/google/start`
- `GET /oauth/google/callback`
- `POST /telegram/setup-webhook`
- `GET /telegram/webhook-info`

## Notes

- The current implementation uses an in-memory store for profiles, pending confirmations and audit entries.
- Google Calendar OAuth callback and token exchange are included, with in-memory token storage for v1.
- When `OPENAI_API_KEY` is not configured, the bot falls back to heuristic intent parsing so the app still works end-to-end.
