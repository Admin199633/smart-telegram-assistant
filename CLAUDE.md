# CLAUDE.md

## Codebase Overview

A Hebrew-first personal assistant Telegram bot that interprets natural-language requests for managing calendar events, shopping/task lists, and reminders. It uses a webhook-driven Express server, routes intent through a heuristic + OpenAI hybrid engine, and requires explicit user confirmation before executing any side-effectful action. The target user is a single Hebrew-speaking individual managing daily life through Telegram.

**Stack**: Node.js 22 (ESM), TypeScript, Express 4, OpenAI Responses API, Google Calendar API, Telegram Bot API, PostgreSQL (scaffold), Zod, Docker  
**Structure**: `src/services/` (business logic), `src/utils/` (shared helpers), `src/app.ts` (factory + routes), `src/types.ts` + `src/supported-actions.ts` (domain types)

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).


## Task Execution Rules

- Execute one task at a time
- Keep scope minimal - only change what's needed for the task
- Modify existing flows only (no parallel implementations)
- OrchestratorService is the single source of truth for routing
- Reuse existing clarification and confirmation flows
- Update `WORKLOG.md` after each task
- Use current project files (not past conversations) as source of truth
- Do not recreate deleted planning files unless explicitly requested


## Architecture Direction (CRITICAL)

- System is conversation-first (not intent-first)
- LLM is used for chat, not for direct action execution
- Actions must be explicitly requested by user
- No automatic action execution
- All actions require confirmation
- Suggested actions are optional and secondary

## Development Rules

- Do not introduce new flows unless necessary
- Do not rebuild existing systems
- Prefer minimal patches over rewrites
- Always reuse orchestrator logic