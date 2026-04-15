# SESSION_HANDOFF

## Current MVP focus
- Lists
- Reminders
- Telegram menu UX
- Persistence
- Production readiness
- Reliability

## Architecture rules
- OrchestratorService is the single source of truth for routing
- Reuse existing clarification and confirmation flows
- Do not add parallel flows
- Prefer minimal localized patches

## Completed recently
- answerCallbackQuery exactly once
- Fix BUTTON_DATA_INVALID

## Current backlog source
- Use the latest execution prompts / backlog from current working doc
- Ignore deleted/old TASK.md references

## Next recommended tasks
- Main menu rendering
- Safe menu callback fallback
- Menu trigger isolation inside existing orchestrator path

## Notes
- Keep callback_data short ASCII
- Keep routing inside existing webhook/orchestrator structure
- Update WORKLOG.md after every task