# Worklog

## 2026-04-15 - Map AI Action → ProposedAction

**What changed:** AI structured actions are now mapped to real `ProposedAction` objects, connecting the AI response to the existing confirmation flow end-to-end.

**Added:**
- `mapAiActionToProposedAction()` — maps AI action types to system types:
  - `reminder` → `CREATE_REMINDER` with `ReminderRequest` payload (requires `text`; `datetime` optional → triggers clarification)
  - `list` → `ADD_TO_LIST` with `ListRequest` payload (requires at least one item)
  - `calendar` → `SCHEDULE_MEETING` with `CalendarRequest` payload (requires `title`; `datetime` optional → triggers clarification)
- Updated `parseStructuredResponse()` to call the mapper for `type: "action"` responses
- Payload validation: missing required fields → downgrade to chat (no crash)
- Unknown action types → downgrade to chat
- Logging for mapping success/failure

**Connected flow:** AI → structured action → ProposedAction → confirm button → service execution. System is now fully connected.

**No changes to:** orchestrator, confirm flow, services, heuristics.

**Files changed:**

| File | Change |
|------|--------|
| `src/services/llm-service.ts` | Added `mapAiActionToProposedAction()`, updated `parseStructuredResponse()` action branch, imported `AgentIntent` type |

---

## 2026-04-15 - AI-First Routing

**What changed:** Reversed the routing priority in `LlmService.interpret()`. AI (structured JSON via OpenAI) is now the **primary** decision maker for all messages. Heuristics are fallback only.

**New flow:**
1. Try structured AI first (for ALL messages, including compose)
2. If AI returns valid result → return immediately, skip heuristics
3. If AI fails (null) → fall back to compose-specific path and general heuristics

**Logging:** Added `logger.info` calls to track whether each message was routed by AI or fell back to heuristics.

**What was removed:** The compose-specific OpenAI call (`tryOpenAiComposeInterpretation`) is no longer tried before the general AI call — the structured AI handles all message types. The compose heuristic fallback path is preserved.

**Safety:** Heuristics are NOT deleted. If AI is unavailable (no API key, network failure, bad JSON), the system behaves exactly as before. No changes to orchestrator, confirmation flow, or services.

**Files changed:**

| File | Change |
|------|--------|
| `src/services/llm-service.ts` | Reordered `interpret()` to call AI first; added logger import; removed compose-specific OpenAI pre-check |

---

## 2026-04-15 - Structured AI Output (JSON Only)

**What changed:** Replaced the free-form OpenAI system prompt in `tryOpenAiInterpretation` with a strict JSON-only prompt. The LLM now returns `{ type: "chat" | "action", message, action? }` instead of the previous loose `AgentInterpretation` format.

**Added:**
- Structured JSON system prompt enforcing `type`/`message`/`action` schema
- Updated OpenAI JSON schema to match the new format
- `parseStructuredResponse()` helper that safely parses and validates the JSON, mapping it back to `AgentInterpretation`
- For `type: "chat"` → returns message only (no action)
- For `type: "action"` → returns message + `suggestedAction` in entities (no execution)

**Fallback mechanism:** If JSON parsing fails, required fields are missing, or the LLM returns unexpected values, the method returns `null` which triggers the existing `heuristicWithSmartFallback` path. No existing flows are broken.

**Files changed:**

| File | Change |
|------|--------|
| `src/services/llm-service.ts` | Rewrote `tryOpenAiInterpretation` prompt + schema; added `StructuredLlmResponse` interface and `parseStructuredResponse()` helper |

---

## 2026-04-15 - Fix List Continuation Hijack

**What was broken:** During active list continuation (ADD_TO_LIST clarification with items phase), every message was blindly treated as a list item. Questions like "מה זה ים?" would be added to the shopping list instead of being routed to normal interpretation.

**What was changed:** Added an `isValidListItem()` guard in `orchestrator.ts`. Before entering `resumeClarification` for the ADD_TO_LIST items phase, the guard checks whether the message looks like a genuine list item. If not (contains `?`, Hebrew question words, or is over 80 chars), the clarification state is cleared and the message falls through to the normal LLM/heuristic interpretation flow.

**Why this works:** The guard is narrowly scoped — it only activates during the items collection phase of ADD_TO_LIST (not during `listId` or `createList` clarification). Normal list items like "חלב", "לחם", "ביצים" pass validation. Questions and long conversational messages are correctly escaped back to normal routing.

**Files changed:**

| File | Change |
|------|--------|
| `src/services/orchestrator.ts` | Added `isValidListItem()` helper + guard in `interpret()` before `resumeClarification` for ADD_TO_LIST items phase |

---

## 2026-04-14 - Fix BUTTON_DATA_INVALID

**Root cause:** `tryOpenAiInterpretation` in `llm-service.ts` (line 549) guarded ID assignment with `!parsed.proposedAction.id`. The OpenAI response schema uses `additionalProperties: true`, so the LLM can include an `id` field with arbitrary content — Hebrew text, long strings, or anything else. That value flowed directly into `confirm:${proposedAction.id}` in `buildTelegramMarkup`, which Telegram rejects with `BUTTON_DATA_INVALID` whenever the id is non-ASCII or the combined string exceeds 64 bytes.

The heuristic path and the compose path both call `createId(prefix)` directly and were unaffected.

**Fix:** Dropped the `!parsed.proposedAction.id` guard so the action ID is *always* overwritten with a controlled `createId("action")` value, regardless of what the LLM returned.

**Files changed:**

| File | Change |
|------|--------|
| `src/services/llm-service.ts` | Line 549: removed `!parsed.proposedAction.id &&` condition — ID now always set by the bot |

---

## 2026-04-14 - answerCallbackQuery exactly once

**Root cause:** `answerCallbackQuery` was already called early (before business logic) for every `callback_query`, satisfying the at-most-once requirement. However, the `await` was unguarded — if the Telegram API returned an error, the thrown exception propagated to the outer `catch`, returning HTTP 500 and causing Telegram to retry the webhook. The early-answer intent was undermined: the spinner still hung and the handler never ran.

**Fix:** Added `.catch(() => undefined)` to the `answerCallbackQuery` call so a transient API error never propagates, the webhook always returns 200, and the business-logic branches always execute.

**Files changed:**

| File | Change |
|------|--------|
| `src/app.ts` | Line 214: `answerCallbackQuery(...).catch(() => undefined)` |

---

## 2026-04-14 - Expand DELETE_LIST language coverage and clarification

**Root cause / gap:** `DELETE_LIST_TRIGGERS` required "רשימת X" — missing three cases: (1) delete intent with no list name ("מחק רשימה"), (2) bare-name delete without the word "רשימה" ("תמחק את קניות"), and (3) missing-name responses returned `OUT_OF_SCOPE` instead of asking for clarification. Additionally, `resumeClarification` had no `DELETE_LIST` handler so clarification answers were silently dropped.

**Fix — files changed:**

| File | Change |
|------|--------|
| `src/utils/normalize.ts` | Added 2 patterns to `DELETE_LIST_TRIGGERS` for missing-name cases ("מחק רשימה", "רוצה למחוק רשימה"); added exported `DELETE_LIST_BARE_TRIGGERS` for bare-name delete |
| `src/services/llm-service.ts` | Imported `DELETE_LIST_BARE_TRIGGERS`; changed missing-name branch from `OUT_OF_SCOPE` to `CLARIFY` with `missingFields: ["listName"]`; added `looksLikeDeleteListBareRequest` + `inferDeleteListBareName` + bare-delete fast-path before ADD_TO_LIST; guarded `looksLikeListRequest` against bare-delete |
| `src/services/orchestrator.ts` | Imported `DELETE_LIST_BARE_TRIGGERS`; added to `looksLikeNewIntent`; expanded `skipNewIntentCheck` so list-name answers don't interrupt DELETE_LIST clarification; added `DELETE_LIST` case in `resumeClarification` |

**Behavior after:**
- "אני רוצה למחוק את רשימת נסיעות" → `למחוק את רשימת נסיעות?` ✓
- "אני לא צריך יותר את רשימת ציוד" → `למחוק את רשימת ציוד?` ✓
- "מחק רשימה" → `איזו רשימה למחוק?` → user answers list name → confirm prompt ✓
- "תמחק את קניות" (when "קניות" list exists) → `למחוק את רשימת קניות?` ✓; if list missing → `לא מצאתי רשימה בשם "קניות"` ✓
- `DELETE_LIST` still runs before `ADD_TO_LIST` ✓

**Build:** `tsc --noEmit` clean.

---

## 2026-04-14 - Feature: DELETE_LIST end-to-end

**Root cause / gap:** No DELETE_LIST intent existed. Delete-list phrases like "מחק את רשימת נסיעות" either fell through to ADD_TO_LIST (because `LIST_ADD_TRIGGERS` matched "רשימת קניות" / "קניות") or to OUT_OF_SCOPE, with no way to actually remove a named list.

**Fix — files changed:**

| File | Change |
|------|--------|
| `src/supported-actions.ts` | Added `DELETE_LIST` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES` |
| `src/types.ts` | Added `DeleteListRequest { listName, listId? }` interface |
| `src/utils/normalize.ts` | Added `DELETE_LIST_TRIGGERS` (3 patterns: direct verb, participial, "לא צריך יותר") |
| `src/services/llm-service.ts` | Added `looksLikeDeleteListRequest`, `inferDeleteListName`, DELETE_LIST heuristic branch before ADD_TO_LIST; guarded `looksLikeListRequest` so delete-list inputs don't route to ADD_TO_LIST |
| `src/services/list-service.ts` | Added `deleteList(userId, listId)` — removes list + items, persists |
| `src/services/orchestrator.ts` | Imported new types/triggers; added DELETE_LIST resolution block (name → id, "not found" guard); added DELETE_LIST execution in `confirm`; added confirmation message; added DELETE_LIST_TRIGGERS to `looksLikeNewIntent` |

**Behavior:**
- "מחק את רשימת נסיעות" → `למחוק את רשימת נסיעות?` → confirm → `רשימת נסיעות נמחקה.`
- "אני לא צריך יותר את רשימת נסיעות" → same flow
- "בטל" alone → unchanged cancel (triggers require "רשימת X" to match DELETE_LIST)
- List not found → `לא מצאתי רשימה בשם "X".`

**Notes:** Build clean (tsc --noEmit). DELETE_LIST runs before ADD_TO_LIST in heuristic routing.

---

## 2026-04-14 - Bug Fix: Infinitive verbs in list items were stripped by command prefix cleaner

**Root cause:** `stripListCommandPrefix` in `llm-service.ts` applies multiple regex replacements in sequence. Step 1 correctly strips the outer command + list target (e.g. `תוסיף לרשימת עבודה `), leaving the remainder of the input. Step 4 was then meant to handle bare shorthand forms like `לקניות: חלב`, but its pattern `^ל[\u0590-\u05FF]+[:\s]+` matched any Hebrew word starting with `ל` followed by a colon **or a space** — including infinitive verbs such as `לשלוח`, `לקנות`, `להזמין`. This caused the verb to be stripped from the item, turning `לשלוח מייל לדן` into `מייל לדן`.

**Fix:** Changed step 4 to require a colon separator (`^ל[\u0590-\u05FF]+:\s*`), so only explicit `לX: item` shorthands are stripped. Infinitive verbs followed by a space are no longer touched. The colon-shorthand case (`לקניות: חלב`) continues to work.

**Files changed:** `src/services/llm-service.ts`, `src/services/llm-service.test.ts` (new), `package.json`

**Behavior fixed:**
- `תוסיף לרשימת עבודה לשלוח מייל לדן` → item: `לשלוח מייל לדן`
- `תוסיף לרשימת עבודה לקנות חלב` → item: `לקנות חלב`
- `תוסיף לרשימת עבודה להזמין כרטיסים` → item: `להזמין כרטיסים`

**Tests:** 11 new tests (3 infinitive-verb cases + 8 regression cases). All 11 pass. Existing 32 normalize tests unchanged.

---

## 2026-04-14 - Bug Fix: ADD_TO_LIST clarification resume loses items ("קניות" reply treated as new intent)

**Root cause:** `LIST_ADD_TRIGGERS` contains the bare pattern `|קניות|` (and the substring match also catches "לקניות"). During an active `ADD_TO_LIST` clarification with `missingFields: ["listId"]`, the user's reply (e.g. "קניות", "לקניות") is fed through `looksLikeNewIntent(normalizeInput(text))` which returns `true`, causing the clarification to be abandoned and original items lost. The bot then re-asked "מה לרשום ברשימת קניות?" instead of proceeding to confirmation.

**Fix:** In `interpret()`, compute `skipNewIntentCheck = true` when the active clarification is `ADD_TO_LIST` with `missingFields.includes("listId")`, and guard the `looksLikeNewIntent` branch with it. All other clarification types (SCHEDULE_MEETING, CREATE_REMINDER, CREATE_LIST, etc.) are unaffected and still support interruption.

**Files changed:** `src/services/orchestrator.ts`

**Behavior fixed:**
- "תוסיף חלב" → bot asks which list → user replies "קניות" → bot responds "להוסיף לרשימת קניות: חלב?" (then on confirm: "הפריטים נוספו לרשימת קניות.")
- Also fixed for "לקניות", numeric "2", and ordinal "הראשונה" (these already parsed correctly once the false-interrupt is removed)

---

## 2026-04-13 - Task: Fix item pollution (commands saved as items)

* Root cause: `inferListItems` lacked a safety guard — if `stripListCommandPrefix` failed to strip a verb (unhandled edge case), the raw command string would be saved as an item.
* Fix: Added `looksLikeRawCommand` guard function that detects lines still starting with list-command verbs (תוסיף/שים/תכניס/הוסף). Updated `inferListItems` to filter out any line matching this guard after stripping. All command patterns (תוסיף/שים/תכניס/הוסף and לרשימת X/לX/ברשימת X) were already present in `stripListCommandPrefix`.
* Files changed: `src/services/llm-service.ts`, `src/app.test.ts`
* Notes: Added two test cases via HTTP API: "תוסיף טונה" → items:["טונה"] (not the raw command), "שים ברשימת סופר עגבניות" → items:["עגבניות"]. Tests pass (Node.js v24 `--test` flag has pre-existing ts-node/esm incompatibility; tests run correctly without `--test`).

---

## 2026-04-13 - Bug Fix: List-Selection Continuation, Item Cleanup, Current-List View

### Root causes and fixes

**1. "הראשונה" (ordinal phrase) not recognized as list index**
- `resolveListReply` handled numeric ("1") and name-based ("קניות") replies but not ordinal phrases.
- "הראשונה" fell through to bare-name lookup → not found → triggered "ליצור רשימה בשם הראשונה?" clarification.
- Fixed: added `ORDINAL_MAP` in `resolveListReply` mapping "הראשונה/הראשון" → 0, "השנייה" → 1, "השלישית" → 2.

**2. "תציג לי את הרשימה" showed all lists instead of current list**
- `LIST_VIEW_ALL_TRIGGERS[2]` used `ה?רשימ(?:ות|ה)` which matched both plural "רשימות" and singular "הרשימה".
- "תציג לי את הרשימה" matched VIEW_ALL (checked first) → returned VIEW_LISTS.
- Fixed: narrowed pattern to require plural "רשימות" OR explicit "כל" before singular "רשימה".
  - "תציג לי את הרשימה" now routes to VIEW_LIST → uses `listLists(userId)[0]` (most recently used).

**3. "גם X" prefix not stripped from items**
- Continuation code `.map` only stripped `^ו+` (conjunction "and"), not `^גם ` ("also").
  "גם אבוקדו" → item saved as "גם אבוקדו".
- `resumeClarification` items branch only stripped `^(?:תוסיף|תוסיפי)` from the whole reply string (not per-item), and didn't cover "גם " prefix.
- Fixed continuation code: added `.replace(/^גם\s+/u, "")` after `^ו+` strip.
- Fixed items branch: replaced single-string verb-strip with per-item strip covering verb+list-target and "גם " prefix.

- Build: clean (tsc --noEmit). Normalize tests: 32/32. Reminder tests: 9/9.
- Files changed: `src/utils/normalize.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`

**Next follow-up: extend `inferRemoveIndex` to handle non-"קניות" lists (currently hardcodes the list name in the remove-detection regex).**

---

## 2026-04-13 - Bug Fix: List Routing, Name Resolution, Item Extraction

### Root causes and fixes

**1. Wrong intent routing — compose captured list phrases**
- Any message containing "הודעה" or "מייל" matched `COMPOSE_TRIGGERS` before list logic was reached (e.g. "תוסיף לרשימת משימות לשלוח הודעה לדן").
- Fixed: added `!looksLikeListRequest(normalized) && !looksLikeCreateListRequest(normalized)` to the compose guard in both `interpret()` and `heuristicInterpretation()`.

**2. List name not extracted for "ל\<name\>" shorthand**
- `inferListName` only matched "לרשימת X" / "ברשימת X" / "רשימת X". Phrases like "תוסיף לקניות חלב" left `listName = undefined`, causing unnecessary "לאיזו רשימה?" clarification.
- Fixed: `inferListName` now also matches `(verb)\s+ל(name)` — i.e. "ל\<name\>" right after a list-action verb (תוסיף/שים/תכניס/הוסף).

**3. Item extraction included full command text**
- `stripListCommandPrefix` did not cover "ל\<name\>" shorthands or verbs "שים"/"תכניס"/"הוסף".
- "תוסיף לקניות אבוקדו, חומוס" → item 1 became "תוסיף לקניות אבוקדו" instead of "אבוקדו".
- Fixed: rewrote `stripListCommandPrefix` with a layered approach:
  1. Verb + any list target (`[לב]רשימת X`, `רשימת X`, `ל<name>`) — covers "תוסיף לקניות", "שים לרשימת סופר", "תכניס לסופר"
  2. Verb alone (target absent or already stripped)
  3. List target at start of line ("לרשימת X:", "ברשימת X")
  4. Bare "ל\<name\>:" shorthand ("לקניות: חלב")
  5. Bare "קניות"/"רשימת קניות" at start
  6. Mid-line list target ("X לרשימת Y" → "X")

**4. New verbs not detected as list triggers**
- "תכניס לרשימת סופר X" matched no `LIST_ADD_TRIGGERS` and fell to OUT_OF_SCOPE.
- Fixed: added `תכניס` to the first regex in `LIST_ADD_TRIGGERS`; added a second pattern for standalone `שים`.

- Build: clean. Tests: 32/32 pass.
- Files changed: `src/utils/normalize.ts`, `src/services/llm-service.ts`, `WORKLOG.md`

**Next follow-up: extend `inferRemoveIndex` to handle non-"קניות" lists (currently hardcodes the list name in the remove-detection regex).**

---

## 2026-04-13 - Feature: Real Multiple-List Support

### Summary
Removed the shopping-list-only restriction. Users can now create, view, and add to any named list.

### Changes
- **`supported-actions.ts`**: added `CREATE_LIST` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`.
- **`types.ts`**: added `CreateListRequest { listName: string }` interface.
- **`normalize.ts`**:
  - Replaced `GENERIC_LIST_TRIGGERS` (which returned a "shopping list only" rejection) with `CREATE_LIST_TRIGGERS` (routes to the new CREATE_LIST flow).
  - Broadened `LIST_VIEW_TRIGGERS` — each pattern now uses `[\u0590-\u05FF]+` instead of the hardcoded word "קניות", so "תציג לי את רשימת סופר" and "מה יש ברשימת משימות" are matched.
- **`llm-service.ts`**:
  - Replaced `looksLikeGenericListRequest` / `GENERIC_LIST_TRIGGERS` import with `looksLikeCreateListRequest` / `CREATE_LIST_TRIGGERS`.
  - Added `CREATE_LIST` heuristic branch: extracts list name via new `inferNewListName()` (checks "בשם X" first, then "רשימת X" construct form); if name found → proposes CREATE_LIST action; if missing → clarifies "איך תרצה לקרוא לרשימה?".
  - Added `inferNewListName(text)` helper.
  - Updated `inferListName(text)` to strip optional definite article prefix from the captured name (`ה?` before capture group).
  - Updated `VIEW_LIST` heuristic branch to pass `listName` in returned entities.
- **`orchestrator.ts`**:
  - Fixed `VIEW_LIST` block: uses `interpretation.entities.listName` to look up the specific list via `findListByName` (not `getOrCreateList("קניות")`); falls back to most-recent list if no name given; shows "לא מצאתי רשימה בשם X" when the named list doesn't exist.
  - Added `CREATE_LIST` confirm branch: calls `listService.getOrCreateList(userId, listName)`.
  - Added `CREATE_LIST` case to `confirmationMessage`.
  - Added `CREATE_LIST` handling in `resumeClarification` (fills in listName from user reply, re-proposes with confirmation).
  - Added `CREATE_LIST_TRIGGERS` to `looksLikeNewIntent` so create-list requests interrupt active clarification flows.
- **`normalize.test.ts`**: renamed `GENERIC_LIST_TRIGGERS` → `CREATE_LIST_TRIGGERS` in import and test names.
- Build: clean. Tests: 32/32 pass.
- Files changed: `src/supported-actions.ts`, `src/types.ts`, `src/utils/normalize.ts`, `src/utils/normalize.test.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`

**Next follow-up: support `REMOVE_FROM_LIST` for non-default lists (currently `inferRemoveIndex` hardcodes "קניות" in its pattern).**

---

## 2026-04-13 - Bug Fix: Clarification Override + List Name "ה" Prefix

### Part 1 — LIST_VIEW_ALL_TRIGGERS accepts singular form
- `normalize.ts`: updated `LIST_VIEW_ALL_TRIGGERS` — all three alternation arms now use `רשימ(?:ות|ה)` instead of `רשימות` so phrases like "איזה רשימה יש לי" also trigger VIEW_LISTS routing.

### Part 2 — normalizeListName strips Hebrew definite article
- `list-service.ts`: `normalizeListName` now strips a leading "ה" prefix before a Hebrew letter (regex `^ה(?=[א-ת])`). Consequence: "הקניות" and "קניות" resolve to the same stored list — user can say either form and never get a duplicate entry or a "list not found" error.

### Part 3 — Clarification override: new intent interrupts active clarification
- `orchestrator.ts`: at the top of the `if (clarification)` block, `normalizeInput(text)` is called and passed to a new module-level helper `looksLikeNewIntent(normalized)`. The helper checks the text against all major trigger families (MEETING_TRIGGERS, CALENDAR_VIEW_TRIGGERS, REMINDER_TRIGGERS, REMINDER_VIEW_TRIGGERS, REMINDER_DELETE_TRIGGERS, REMINDER_SNOOZE_TRIGGERS, LIST_ADD_TRIGGERS, LIST_VIEW_TRIGGERS, LIST_VIEW_ALL_TRIGGERS, LIST_REMOVE_TRIGGERS). If any match, the clarification state is cleared and execution falls through to normal routing — the new intent is handled correctly. If none match, the existing `resumeClarification` path runs unchanged.
- Added import of the required trigger families from `normalize.ts` in `orchestrator.ts`.
- Build: clean. Tests: 32/32 pass (normalize.test.ts run directly).
- Files changed: `src/utils/normalize.ts`, `src/services/list-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`

**Next block: Block 7 - Recurring Reminders (first task: recurrence parsing for daily/weekly phrases).**

---

## 2026-04-13 - Block 6 complete: Reminder Management

### Task: Add view reminders flow
- `supported-actions.ts`: added `VIEW_REMINDERS` and `DELETE_REMINDER` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`.
- `normalize.ts`: added `REMINDER_VIEW_TRIGGERS` phrase family (4 patterns: "מה התזכורות שלי", "תציג תזכורות", etc.).
- `llm-service.ts`: imported `REMINDER_VIEW_TRIGGERS`; added `looksLikeViewRemindersRequest` helper; updated `looksLikeReminderRequest` to return false when view-triggers match; added detection branch in `heuristicInterpretation`.
- `orchestrator.ts`: added `VIEW_REMINDERS` response block — filters pending, sorts by datetime, formats as numbered list.
- Files changed: `src/supported-actions.ts`, `src/utils/normalize.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`

### Task: Add delete reminder flow
- `types.ts`: added `DeleteReminderRequest` interface.
- `reminder-service.ts`: added `deleteReminder(userId, reminderId): boolean`.
- `normalize.ts`: added `REMINDER_DELETE_TRIGGERS` (2 patterns: "מחק תזכורת", "מחק תזכורת מספר N").
- `llm-service.ts`: added `looksLikeDeleteReminderRequest`, detection branch in heuristic — extracts index from phrase; uses `__index_N` placeholder resolved at confirm time.
- `orchestrator.ts`: added `DELETE_REMINDER` confirm branch (resolves index → id, calls `deleteReminder`); added case to `confirmationMessage`.
- Files changed: `src/types.ts`, `src/services/reminder-service.ts`, `src/utils/normalize.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`

### Task: Add postpone / snooze flow
- `types.ts`: added `SnoozeReminderRequest`.
- `supported-actions.ts`: added `SNOOZE_REMINDER` to action types and intent values.
- `reminder-service.ts`: added `snoozeReminder(userId, reminderId, newDatetime)` — updates datetime and resets status to pending.
- `normalize.ts`: added `REMINDER_SNOOZE_TRIGGERS` (4 patterns: "דחה תזכורת", "הזז תזכורת", "תזכיר שוב", snooze).
- `llm-service.ts`: added `looksLikeSnoozeReminderRequest`, detection branch — extracts index + new time, uses `__index_N` placeholder.
- `orchestrator.ts`: added `SNOOZE_REMINDER` confirm branch; added case to `confirmationMessage`.
- Files changed: `src/types.ts`, `src/supported-actions.ts`, `src/services/reminder-service.ts`, `src/utils/normalize.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`

### Task: Improve reminder listing UX
- `orchestrator.ts`: improved `VIEW_REMINDERS` response — adds relative day labels ("היום"/"מחר") via new `reminderDayLabel` helper; appends delete/snooze hint line.
- Files changed: `src/services/orchestrator.ts`

### Task: Add tests for reminder management
- Created `src/services/reminder-service.test.ts` — 9 tests covering create, list, due reminders, markSent, deleteReminder, snoozeReminder.
- `package.json`: added test file to test script.
- Files changed: `src/services/reminder-service.test.ts` (new), `package.json`

### Task: Verify reminder execution reliability
- `reminder-execution-engine.ts`: added `running` flag guard to prevent overlapping executions. Changed execution order — mark reminder as sent BEFORE calling `executeReminder` to prevent duplicate delivery if the send throws. Wrapped `executeReminder` in try/catch so one failure doesn't block remaining reminders in the same tick.
- Files changed: `src/services/reminder-execution-engine.ts`

**Block 6 complete. Next block: Block 7 - Recurring Reminders.**

## 2026-04-13 - Block 4: Add normalization for frequent typo variants

- Block: Block 4 - Typo Tolerance
- Task completed: Add normalization for frequent typo variants
- `normalize.ts`: added 5 targeted typo corrections to `normalizeInput`, ordered after the existing `רשימהת` fix: `ארוע`→`אירוע` (event, missing yod — used Hebrew lookbehind/lookahead `(?<![א-ת])…(?![א-ת])` since `\b` doesn't work for Hebrew), `תזכרת`→`תזכורת` (reminder, missing vav), `קנייות`→`קניות` (shopping, double yod), `תוסיפ`→`תוסיף` (add-verb, missing final-pe, anchored with `(?=\s|$)`).
- `normalize.test.ts`: added 6 tests covering each new correction plus a "no-op when already correct" case.
- Build: clean. Tests: 32/32 pass.
- Files changed: `src/utils/normalize.ts`, `src/utils/normalize.test.ts`, `WORKLOG.md`
- Next task in block: Support close variants of shopping-list phrases

## 2026-04-13 - Block 3: Support reordered calendar phrasing

- Block: Block 3 - Syntax Flexibility
- Task completed: Support reordered calendar phrasing
- `normalize.ts`: added construct-form nouns (`פגישת`, `ישיבת`, `ועידת`) to `MEETING_TRIGGERS` — these are the most common Hebrew reordering case ("ישיבת צוות מחר" instead of "פגישה מחר"). Also added construct forms to `CALENDAR_UPDATE_TRIGGERS` and `CALENDAR_DELETE_TRIGGERS` for consistency.
- `llm-service.ts`: rewrote the verb-stripping step in `inferMeetingTitle` — changed from anchored `^verb` (only strips at start) to unanchored `\bverb\s*(?:לי\s+)?` (strips verbs anywhere in the string). This fixes title extraction when time comes first: "מחר ב-14 תקבע לי ישיבת צוות" → "ישיבת צוות". Added `השבוע` and `פגישת` to the noun-stripping step. Added a `ב-?\d{1,2}(?::\d{2})?` pattern to strip bare hour references ("ב-14", "ב-9:30") that the existing `בשעה N` pattern missed.
- Build: clean. Tests: 26/26 pass.
- Files changed: `src/utils/normalize.ts`, `src/services/llm-service.ts`, `WORKLOG.md`
- Next task in block: Support reordered reminder phrasing

## 2026-04-13 - Block 2: Broaden calendar phrase coverage (create/view/update/delete)

- Block: Block 2 - Hebrew Vocabulary Expansion
- Task completed: Broaden phrase coverage for calendar create/view/update/delete
- `normalize.ts`: expanded `MEETING_TRIGGERS` from a single broad regex to 8 targeted patterns covering creation verbs (תקבע, תזמן, תרשום…ביומן, צור אירוע) and nouns (מפגש, ישיבה, ועידה, תור). Added three new exported phrase families: `CALENDAR_VIEW_TRIGGERS` (מה יש לי ביומן, מה קבוע לי, אירועים היום…), `CALENDAR_UPDATE_TRIGGERS` (שנה/עדכן/דחה פגישה…), `CALENDAR_DELETE_TRIGGERS` (בטל/מחק פגישה…).
- `llm-service.ts`: imported the three new trigger constants. Added `looksLikeCalendarViewRequest`, `looksLikeCalendarUpdateRequest`, `looksLikeCalendarDeleteRequest` helpers. Updated `looksLikeMeetingRequest` to return false when a view/update/delete trigger matches (prevents "מה יש לי ביומן" being routed as a create). Added three branches in `heuristicInterpretation` before the meeting branch that return informative OUT_OF_SCOPE messages for view/update/delete (feature not yet available). Expanded `inferMeetingTitle` prefix-strip to cover the new creation verbs and `ליומן`/`אירוע` nouns.
- Build: clean. Tests: 26/26 pass.
- Files changed: `src/utils/normalize.ts`, `src/services/llm-service.ts`, `WORKLOG.md`
- Next task in block: Broaden phrase coverage for reminders create/view/cancel

## 2026-04-13 - Bug Fix: "כן" Treated as List Item Instead of Confirmation

- Root cause: when a pending `ADD_TO_LIST` action was waiting for the user to tap the "אשר" button and the user typed "כן" as text instead, `orchestrator.interpret()` had no pending-confirmation intercept. The text fell through to the LLM (OUT_OF_SCOPE), then hit the shopping-list continuation guard (last bot message contained "לרשימת"), which accepted "כן" as a new item — producing a second `להוסיף: כן?` prompt.
- Fixed in `memory-store.ts`: added `pendingActionByUser` map (`userId → actionId`) with three methods: `setPendingActionUser`, `getPendingActionIdForUser`, `clearPendingActionUser`.
- Fixed in `orchestrator.ts`:
  1. Added text-confirmation intercept at the top of `interpret()` (after clarification check, before LLM call): looks up the user's pending action; if text is a yes-phrase calls `this.confirm()` and returns the result; if text is a no-phrase clears the pending action and returns "בוטל.". Both paths append conversation turns and return immediately — the LLM and continuation logic are never reached.
  2. Added `setPendingActionUser` calls after every `savePendingAction` (both clarification-resume and main paths), guarded to only register when intent is not CLARIFY (clarification rounds don't create a final confirmable action).
  3. Added `clearPendingActionUser` in `confirm()` alongside `removePendingAction` so button-click confirmations also clean up the user mapping.
  4. Added "כן|yes|אוקי|בסדר" to the continuation-item exclusion filter as a safety net.
  5. Added module-level helpers `looksLikeTextConfirm` and `looksLikeTextCancel`.
- Build: clean. Tests: 26/26 pass.
- Files changed: `src/services/memory-store.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next: no follow-up in scope for this task.

## 2026-04-13 - Block 1 Complete: Normalization Tests and Pattern Fix

- Block: Block 1 - Language Understanding Foundation
- Task completed: Add tests for normalization edge cases
- Created `src/utils/normalize.test.ts` — 26 tests covering: `normalizeInput` (whitespace collapse, punctuation dedup, עוד→בעוד, ב→ב-N, typo correction, idempotency, trim) and `matchesAny` + all exported phrase-family constants (REMINDER_TRIGGERS, MEETING_TRIGGERS, LIST_ADD_TRIGGERS, LIST_VIEW_TRIGGERS, LIST_VIEW_ALL_TRIGGERS, LIST_REMOVE_TRIGGERS, GENERIC_LIST_TRIGGERS).
- Fixed bug found by tests: `GENERIC_LIST_TRIGGERS` first pattern used `\b` word boundary after Hebrew text — `\b` only transitions between ASCII `\w` and `\W`, so it never fired at end of a Hebrew word. Changed `(?:רשימה|רשימת)\b` to `רשימה(?:\s|$)`, which correctly anchors to whitespace or end-of-string while also removing the `רשימת` alternative (construct-form implies a named list follows, not a generic create).
- Updated `package.json` test script to include `src/utils/normalize.test.ts`.
- All 26 tests pass.
- Files changed: `src/utils/normalize.test.ts` (new), `src/utils/normalize.ts`, `package.json`, `WORKLOG.md`
- Block 1 is fully complete. Next block: Block 2 - Hebrew Vocabulary Expansion.

## 2026-04-13 - Feature: Numbered List Options and Natural Clarification Replies

- Implemented: two UX improvements to the multi-list clarification flow.
- **Numbered list display**: `resolveListForInterpretation` now formats the ambiguous-list question as a numbered list instead of a comma-joined string. E.g. "לאיזו רשימה להוסיף?\n\n1. קניות\n2. משימות\n3. סופר".
- **Natural `listId` replies**: the `listId` clarification branch now calls `resolveListReply(replyText, topLists)` instead of using `replyText.trim()` as-is. `resolveListReply` (new module-level helper) accepts: numeric index ("1"/"2"/"3" → looks up by position in the suggestion slice), bare name ("קניות"), prepositional prefix ("לקניות", "לסופר"), or full prefixed form ("רשימת קניות", "לרשימת קניות"). Case-insensitive match against suggestion names; falls back to the stripped text for unknown names.
- **Redirect from `createList` negative**: the `createList` branch now calls `extractListRedirect(replyText)` (new module-level helper) before falling to OUT_OF_SCOPE. Detects patterns like "לא, לקניות" / "לא, לרשימת קניות" / "לא, תוסיף לרשימת קניות". When a redirect target is found, returns ADD_TO_LIST (or CLARIFY items if payload is empty) with `listName` set to the redirected list; `resolveListForInterpretation` downstream resolves the actual list ID or prompts to create it if it doesn't exist either.
- Files changed: `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: add inline keyboard buttons with the numbered list options (1 / 2 / 3 buttons) for the `listId` clarification question, parallel to the yes/no buttons for `createList`.

## 2026-04-13 - Feature: Inline Yes/No Buttons for Binary Clarification

- Implemented: binary clarification questions (currently "ליצור אותה? (כן / לא)" for missing named lists) now show Telegram inline keyboard buttons "כן" / "לא" in addition to accepting free-text replies. Both paths converge on the same `orchestrator.interpret()` call so the state machine is unchanged.
- `app.ts` — `buildTelegramMarkup`: changed the CLARIFY guard from a blanket `return undefined` to a conditional branch: if `proposedAction.missingFields` includes `"createList"`, returns an `inline_keyboard` with two buttons (`callback_data: "clarify:yes"` and `"clarify:no"`); all other CLARIFY cases continue to return `undefined` (free-text reply expected).
- `app.ts` — webhook handler: added a `clarify:` callback handler block (parallel to the existing `confirm:` block) — maps `"clarify:yes"` → `"כן"` and `"clarify:no"` → `"לא"`, calls `orchestrator.interpret(userId, answer)`, answers the callback query, builds markup, and sends the result message. Text replies continue to route through the existing `incomingText` block unchanged.
- Files changed: `src/app.ts`, `WORKLOG.md`
- Next follow-up: extend binary-button support to additional yes/no clarifications if they are added (e.g. reminder confirmation variants); consider editing the bot message instead of sending a new one when the user clicks a button (avoids chat clutter).

## 2026-04-13 - Feature: Multi-List Support with Explicit Clarification

- Implemented: upgraded shopping-list infrastructure to support multiple named lists per user with explicit clarification when the target list is ambiguous or missing.
- `types.ts`: added `lastUsedAt?: string` to `ShoppingList`; added `listName?: string`, `targetListId?: string`, `createIfMissing?: boolean` to `ListRequest`.
- `list-service.ts`: `listLists()` now sorts by `lastUsedAt desc` (falls back to `createdAt`) so recent lists surface first; added `touchList(listId)` to stamp `lastUsedAt` on use; `addItems()` calls `touchList` after a successful add.
- `normalize.ts`: removed the `רשימת\s+(?!קניות)` GENERIC_LIST_TRIGGERS pattern that was blocking valid multi-list add requests (e.g. "תוסיף לרשימת משימות X"); kept the "תיצור לי רשימה" and "רשימה חדשה" patterns that correctly block generic list-creation commands.
- `llm-service.ts`: added `inferListName(text)` (matches `(?:לרשימת|ברשימת|רשימת)\s+<word>`); updated ADD_TO_LIST block to extract and store `listName` in payload and use it in draft responses; updated `stripListCommandPrefix` to strip "לרשימת X" from individual lines covering dynamic list names.
- `orchestrator.ts`: added private `resolveListForInterpretation(userId, interpretation)` — if intent is ADD_TO_LIST: if `targetListId` already set, pass through; if `listName` set and list exists, resolve ID; if `listName` set but missing and `createIfMissing`, create it; if `listName` set and missing and no flag, CLARIFY "ליצור אותה?"; if no `listName` and 0–1 lists, auto-select; if no `listName` and multiple lists, CLARIFY with up to 3 recent suggestions. Wired into both the clarification-resume path and the main interpret path (replaces raw `interpretation` before conversation save). Continuation block now extracts `listName` from last bot message. `resumeClarification` ADD_TO_LIST branch handles "createList" (yes/no) and "listId" (user picks list) missing fields, preserving all existing payload fields. `confirm` ADD_TO_LIST uses `targetListId ?? getOrCreateList(listName ?? "קניות")`. Confirmation message shows actual list name.
- Files changed: `src/types.ts`, `src/services/list-service.ts`, `src/utils/normalize.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: persist lists and items to disk (parallel to Google tokens) so they survive server restart; add REMOVE_FROM_LIST support for named lists beyond the default "קניות".



## 2026-04-13 - Bug Fix: Shopping List Continuation, Typo Tolerance, Scope Enforcement

- Root cause A (add-more continuation): after `resumeClarification` returns `ADD_TO_LIST` and clears the clarification state, subsequent item-like replies (e.g. "ועגבניה") had no active clarification and matched no list trigger, falling to `OUT_OF_SCOPE`. Fixed in `orchestrator.interpret()`: after LLM returns `OUT_OF_SCOPE`, check if the last assistant conversation turn contains "לרשימת הקניות" or "רשימת הקניות"; if so, split the reply by newlines/commas, strip leading Hebrew conjunction "ו", filter out command-like words, and re-route as `ADD_TO_LIST`. This preserves context across multiple item-entry turns without changing the clarification state machine.
- Root cause B (typo tolerance): "מה יש ברשימהת קניות" had "רשימהת" which matched neither `LIST_VIEW_TRIGGERS` nor `LIST_ADD_TRIGGERS`. Fixed in `normalizeInput` in `normalize.ts`: added `.replace(/רשימהת/gi, "רשימת")` before intent detection so the corrected form reaches the triggers.
- Root cause C (scope enforcement): "תיצור לי רשימת משימות למחר" and similar generic-list phrases either fell to `OUT_OF_SCOPE` silently or were at risk of being picked up as continuation items. Fixed: added `GENERIC_LIST_TRIGGERS` to `normalize.ts` (patterns for "רשימת <non-קניות>", "תיצור לי רשימה", "רשימה חדשה") and `looksLikeGenericListRequest` in `llm-service.ts`, checked before `looksLikeRemoveFromListRequest` and `looksLikeListRequest`; returns a clear Hebrew "shopping list only" message. The continuation guard in the orchestrator also excludes replies starting with "תיצור" or "רשימה".
- Files changed: `src/utils/normalize.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: persist shopping list to disk (like Google tokens) so items survive server restart; add unit tests for continuation and scope-enforcement paths.



## 2026-04-13 - Foundation: Shared Input Normalization and Phrase Families

- Implemented: created `src/utils/normalize.ts` with two exports: `normalizeInput(text)` — a light canonical pass (collapse spaces, deduplicate punctuation, "עוד X"→"בעוד X", "ב X"→"ב-X") applied before any intent detection — and `matchesAny(text, patterns)` — a helper that returns true if text matches any pattern in a `ReadonlyArray<RegExp>`. All intent phrase patterns previously scattered as inline literals across `llm-service.ts` are now exported phrase-family constants: `REMINDER_TRIGGERS`, `MEETING_TRIGGERS`, `COMPOSE_TRIGGERS`, `LIST_ADD_TRIGGERS`, `LIST_VIEW_TRIGGERS`, `LIST_VIEW_ALL_TRIGGERS`, `LIST_REMOVE_TRIGGERS`, `APP_ACTION_TRIGGERS`.
- In `llm-service.ts`: `interpret()` now calls `normalizeInput(text)` once at entry and passes the result to `heuristicInterpretation` (OpenAI calls still receive original text). `heuristicInterpretation` uses `normalizeInput` on its input (idempotent when already normalized). Every `looksLike*` function now delegates to `matchesAny(text, <family>)` instead of inline regex literals — making vocabulary additions a single-file, single-entry change in `normalize.ts`.
- Files changed: `src/utils/normalize.ts` (new), `src/services/llm-service.ts`, `WORKLOG.md`
- Next follow-up: add lightweight typo-tolerance to `normalizeInput` for common Hebrew keyboard errors (e.g. "רשיימת" → "רשימת", "תזכיר" variants) and extend phrase families with additional natural phrasing variants discovered from user testing.



## 2026-04-13 - Bug Fix: REMOVE_FROM_LIST Phrase Coverage

- Root cause: `looksLikeRemoveFromListRequest` only matched three base verbs (`תסיר|מחק|הסר`) and required the digit to follow immediately after an optional "את". This excluded: (a) future-tense forms "תמחק" and "תוריד", (b) phrases with "מרשימת הקניות" between the verb and the index, and (c) "פריט N" or "מספר N" as alternatives to "את N".
- Fixed: expanded both the detection regex and the extraction regex in `looksLikeRemoveFromListRequest` and `inferRemoveIndex` to: add verbs "תמחק", "תוריד", "הוריד"; allow an optional "מרשימת ה?קניות" group after the verb; accept "את", "פריט", or "מספר" as optional prefixes before the digit.
- Files changed: `src/services/llm-service.ts`, `WORKLOG.md`
- Next follow-up: support remove by item name ("תסיר טונה") in addition to index, and show the item text in the removal confirmation ("להסיר 'טונה' מרשימת הקניות?").



## 2026-04-13 - Bug Fix: Shopping List Command Cleanup, Real View-Lists, Remove-by-Index

- Root cause 1 (command line as item): `inferListItems` split the full text by `[\n,،]+` and passed every resulting line through unchanged. When the first line was "תיצור לי רשימת קניות", the existing prefix-strip regex only covered the start of the full string (not individual lines after splitting), so the command line survived as item #1. Fixed: moved the prefix-strip logic into a per-line helper `stripListCommandPrefix` that runs on every split line; command-only lines collapse to empty string and are filtered out.
- Root cause 2 (VIEW_LISTS static): VIEW_LISTS intent returned a static "אין לי עדיין רשימות שמורות." because `orchestrator.interpret()` only resolved VIEW_LIST against live data, not VIEW_LISTS. Fixed: added a parallel block for `VIEW_LISTS` in `orchestrator.interpret()` — calls `listService.listLists(userId)` and formats the result as a numbered Hebrew list.
- Root cause 3 (no remove): No `REMOVE_FROM_LIST` intent or execution path existed. Fixed: added `REMOVE_FROM_LIST` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`; added `looksLikeRemoveFromListRequest` / `inferRemoveIndex` in `llm-service.ts`; added `removeItemByIndex` to `ListService` (marks item as "completed" by 1-based active index); added confirm case in `orchestrator.confirm()` and confirmation message.
- Files changed: `src/supported-actions.ts`, `src/types.ts`, `src/services/list-service.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: support remove by item name ("תסיר טונה") in addition to index, and show the item text in the removal confirmation ("להסיר 'טונה' מרשימת הקניות?").



## 2026-04-13 - Bug Fix: VIEW_LISTS Phrase Detection

- Root cause: `looksLikeViewListsRequest` matched `(?:איזה|אילו|כמה|מה)\s+רשימות` and `רשימות\s+(?:יש|קיימות|שלי)` but missed phrases where: (a) the trigger verb leads ("תציג/תראה … את כל הרשימות"), (b) "כל" precedes the noun, or (c) the noun carries a ה definite prefix ("הרשימות"). Fixed: expanded regex to three alternation arms — `(?:איזה|אילו|כמה|מה)\s+(?:כל\s+)?ה?רשימות` (question-word led), `ה?רשימות\s+(?:יש|קיימות|שלי)` (noun led, existing), and `(?:תציג|תראה|הצג|הראה)\s+(?:לי\s+)?(?:את\s+)?(?:כל\s+)?ה?רשימות` (verb led). All optional modifiers (לי, את, כל, ה) are non-capturing optional groups.
- Files changed: `src/services/llm-service.ts`, `WORKLOG.md`
- Next follow-up: wire actual list enumeration into the VIEW_LISTS response in `orchestrator.interpret()` (parallel to the VIEW_LIST fix) so it returns real list names instead of the static "אין לי עדיין רשימות שמורות."



## 2026-04-13 - Bug Fix: Shopping List View Flow

- Root cause 1: `VIEW_LIST` response was a static string in `llm-service.ts` which has no access to `ListService`. The service already has `listService` injected into `OrchestratorService` but `interpret()` never used it for view intents. Fixed: after `llm.interpret()` returns in `orchestrator.interpret()`, check for `VIEW_LIST` intent and replace `draftResponse` with the real list — calls `listService.getOrCreateList(userId, "קניות")` then `listService.listItems(list.id)`, filters active items, and formats as a numbered Hebrew list (or "ריקה כרגע" if empty).
- Root cause 2: `looksLikeViewListRequest` matched "רשימת הקניות" and "הרשימה" but not "הרשימת קניות" (ה prefix on רשימת) or "מה יש ברשימת הקניות". So "תציג לי את הרשימת קניות" fell through to `looksLikeListRequest` which matched "קניות". Fixed: broadened regex to `ה?רשימת\s+ה?קניות` (optional ה on both words) and added a `מה\s+יש\s+ב…` clause for containment queries. Since `looksLikeListRequest` guards against `looksLikeViewListRequest`, view phrases are now correctly excluded from add-to-list.
- Files changed: `src/services/orchestrator.ts`, `src/services/llm-service.ts`, `WORKLOG.md`
- Next follow-up: support item removal from the list (intent `REMOVE_FROM_LIST`) so users can say "תמחק טונה מהרשימה".



## 2026-04-13 - Bug Fix: Shopping List Intent Routing & Item Parsing

- Root cause 1: `inferListItems` split on `[\s,،]+` (includes spaces), so multi-word items like "נייר אפייה" were broken into two separate items. Fixed: changed split regex to `[\n,،]+` so only commas and newlines are separators; spaces within an item are preserved.
- Root cause 2: `looksLikeListRequest` matched "רשימת קניות" in view-list phrases like "מה רשימת הקניות שלי" and "תציג לי את רשימת הקניות", routing them into add-to-list flow. Fixed: added `looksLikeViewListRequest` (detects "מה/תציג/הצג/תראה … רשימת הקניות" and "רשימת הקניות שלי") and `looksLikeViewListsRequest` (detects "איזה/אילו/כמה/מה רשימות"). Both new guards are checked before `looksLikeListRequest` in `heuristicInterpretation`, and `looksLikeListRequest` itself returns false when either matches.
- Root cause 3: No `VIEW_LIST` or `VIEW_LISTS` intent existed, so list-discovery phrases fell through to the generic out-of-scope fallback. Fixed: added `VIEW_LIST: "view_list"` and `VIEW_LISTS: "view_lists"` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`.
- Root cause 4: The `ADD_TO_LIST` branch in `orchestrator.resumeClarification` also split on `[\s,،]+`, repeating the multi-word bug in the clarification path. Fixed: changed to `[\n,،]+`. Also added `looksLikeListCommand` guard (detects "להציג/הצג/תציג/לראות/ראה/תראה/מה יש/הראה" at start of reply) — when matched, returns OUT_OF_SCOPE so command-like words are never added as list items.
- Files changed: `src/supported-actions.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: wire actual list reading in VIEW_LIST response — query `ListService.listItems` for the user's default list and format the items as a Hebrew reply instead of the static "הרשימה שלך ריקה כרגע."



## 2026-04-12 - Reminder Confirmation & Execution

- Implemented: `orchestrator.confirm` now handles `CREATE_REMINDER` — reads `ReminderRequest` payload, calls `reminderService.createReminder(userId, text, datetime, chatId)` and returns a Hebrew success message. `OrchestratorService` now accepts an optional `ReminderService` constructor arg. `confirm` accepts an optional `chatId` parameter passed from the Telegram webhook callback handler so each reminder knows which chat to message. Added `chatId?: number` to the `Reminder` type and `ReminderService.createReminder`. Added a `setInterval` (30 s) in `createApp` that calls `reminderExecution.runDueReminders` and sends the due reminder text via `telegram.sendMessage` to `reminder.chatId ?? Number(reminder.userId)`.
- Files changed: `src/types.ts`, `src/services/reminder-service.ts`, `src/services/orchestrator.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: persist reminders across restarts (write to disk like google-tokens.json) so reminders are not lost on server restart.

## 2026-04-12 - Bug Fix: Invalid Attendee Email Rejected by Google Calendar

- Root cause: `CalendarService.createEvent` and `updateEvent` passed every entry in `request.participants` directly to the Google Calendar `attendees` field as `{ email }`. The LLM extracts participant names from natural language (e.g. "דני") and stores them as strings in `participants`. Google Calendar rejects any attendee whose `email` value is not a valid RFC-5321 address, returning 400.
- Fixed: added a private `isValidEmail` helper (regex: `[^\s@]+@[^\s@]+\.[^\s@]+`) and applied `.filter(isValidEmail)` before mapping participants to attendee objects in both `createEvent` and `updateEvent`. Non-email names are silently dropped; real email addresses pass through unchanged.
- Files changed: `src/services/calendar-service.ts`, `WORKLOG.md`
- Next follow-up: surface filtered-out participant names in the confirmation message so the user knows which names were not invited (e.g. "הזמנה נשלחה — דני לא נוסף כי אין כתובת מייל").

## 2026-04-12 - Feature: Shopping List Intent Detection

- Implemented: added `ADD_TO_LIST` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`. Added `ListRequest` type (`{ items: string[] }`). Added `looksLikeListRequest` (triggers on רשימת קניות / קניות / תוסיף) and `inferListItems` (strips trigger phrases, splits by whitespace/comma) in `llm-service.ts`. The heuristic runs before the app-action check; if no items are extracted, returns a clarification question. Added `ADD_TO_LIST` confirmation message in `orchestrator.ts`. No storage yet — confirm falls through to `result = action.payload`.
- Files changed: `src/supported-actions.ts`, `src/types.ts`, `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next step: wire `ADD_TO_LIST` confirm in `orchestrator.confirm` to call `ListService.addItems` so items are actually persisted.

## 2026-04-12 - Feature: Extended Reminder Time Parsing (Days, Weeks, Relative Dates, Hebrew Hours)

- Implemented: five gaps fixed across `time.ts` and `llm-service.ts`:
  1. **"מחר בחמש" / Hebrew clock-hour words**: added `HEBREW_HOUR_AT_SUBS` table ("בחמש"→"ב5", "בשלוש"→"ב3", etc., 12 entries ordered longest-first). Applied in `normalizeHebrewWordTime` after duration subs, so "בחמש דקות" → "ב5 דקות" (not "ב5 שעות").
  2. **"מחר ב-5" / dash-prefixed hours**: added `result.replace(/ב-(\d)/g, "ב$1")` in `normalizeHebrewWordTime` to strip the dash before any further parsing.
  3. **"עוד X" in direct parsing**: added `result.replace(/(^|\s)עוד\s+/g, "$1בעוד ")` in `normalizeHebrewWordTime` so "עוד יומיים" normalises to "בעוד יומיים" everywhere, not just in clarification.
  4. **"עוד יומיים" / "עוד שבוע" / "X ימים" / "X שבועות"**: added four day/week duration patterns to `parseRelativeDuration`.
  5. **"5 בצהריים" (standalone digit + fuzzy period)**: added `standaloneHour` detection in `parseRelativeDate`; when `hourMatch`/`amPm` are absent but `fuzzyHour` and a lone digit exist, computes the adjusted hour (e.g. +12 for afternoon/evening) and uses `now` as base date.
  - Also extended `inferReminderText` in `llm-service.ts` to strip: "עוד/בעוד יומיים/שבוע/ימים/שבועות", "ב-DD.MM" explicit dates, Hebrew clock-hour words ("בחמש" etc.), and generic "ב-N" hour references.
- Files changed: `src/utils/time.ts`, `src/services/llm-service.ts`, `WORKLOG.md`
- Next follow-up: add unit tests in `time.test.ts` covering: "מחר בחמש", "מחר ב-5", "5 בצהריים", "עוד יומיים", "עוד שבוע", "ב-17.6 בשעה 5".

## 2026-04-12 - Feature: Hebrew Word-Based Time Expressions

- Root cause: `parseRelativeDuration` matched only numeric amounts (e.g. "בעוד 5 דקות") with no handling for Hebrew word-number phrases like "חמש דקות", "רבע שעה", or "חצי שעה". Since `tryParseReplyAsTime` delegates entirely to `parseNaturalLanguageDate`, word-based replies silently fell through all parse attempts and were stored as reminder text instead of datetime.
- Fixed: added `HEBREW_WORD_TIME_SUBS` substitution table (longer phrases first to avoid substring collisions) and `normalizeHebrewWordTime` in `time.ts`. Called it at the very start of `parseNaturalLanguageDate` before any parsing, replacing word-based phrases with their numeric equivalents (e.g. "חמש דקות" → "5 דקות", "רבע שעה" → "15 דקות", "חצי שעה" → "30 דקות"). Because the normalization is in `parseNaturalLanguageDate`, it applies to both direct reminder parsing and clarification resume — no changes needed in `orchestrator.ts`.
- Files changed: `src/utils/time.ts`, `WORKLOG.md`
- Next follow-up: extend `HEBREW_WORD_TIME_SUBS` with tens ("שלושים", "ארבעים", "חמישים" דקות) and hour multiples ("שלוש שעות", "ארבע שעות") so the table covers the full common range.

## 2026-04-12 - Bug Fix: Cancel Not Exiting Clarification Flow

- Root cause: `looksLikeCancelReply` used `\b` (word boundary) after Hebrew phrases like "לא משנה". JavaScript's `\b` only transitions between ASCII `\w` (`[a-zA-Z0-9_]`) and `\W`. Hebrew characters are `\W`, so `\b` after "ה" (end of "לא משנה") never fires — the regex always returned false for Hebrew cancel phrases. Additionally, the cancel check only appeared inside the `CREATE_REMINDER` type branch, so SCHEDULE_MEETING clarification had no cancel path at all.
- Fixed: replaced `\b` with `(?:\s|$)` in `looksLikeCancelReply` so the boundary works for both Hebrew and ASCII text. Moved the cancel check to the very top of `resumeClarification` before any action-type branching, making it universal for all clarification types. Removed the now-duplicate cancel block from inside the `CREATE_REMINDER` branch.
- Files changed: `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: add unit tests for `looksLikeCancelReply` covering Hebrew and English phrases, and a test for the full cancel-exits-clarification path in `orchestrator.confirm`.

## 2026-04-12 - Bug Fix: Reminder Clarification Time Detection & Text Overwrite

- Root cause 1: `tryParseReplyAsTime` did not normalise "עוד X דקות" — the Hebrew prefix "עוד" is semantically identical to "בעוד" but `parseRelativeDuration` only matches "בעוד". So "עוד 5 דקות" fell through all three parse attempts, was treated as reminder text, and stored in `updatedText`.
- Root cause 2: On the next turn, when the user typed a form that DID parse as time (e.g. "5 דקות"), the `if (parsedTime?.startAt)` branch kept `updatedText = existing.text` unchanged — which was the stale time phrase from the previous wrong turn.
- Fixed: added `normalizeTimeReply` that strips a leading "עוד " and replaces it with "בעוד " before any parsing attempt. In the time-detected branch of `resumeClarification`, added a guard: if the existing text itself parses as a time phrase via `tryParseReplyAsTime`, clear it so the user is re-asked for real reminder text.
- Files changed: `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: add a standalone Hebrew single-unit pattern ("דקה", "שעה") to `parseRelativeDuration` in `time.ts` so replies like "דקה" without any prefix also resolve to a valid time.

## 2026-04-12 - Bug Fix: Reminder Clarification Loop

- Root cause: `resumeClarification` for `CREATE_REMINDER` used `missingFields.includes("text")` to decide which field the reply fills. When `text` was missing, any reply — including "5 דקות" — was stored as reminder text instead of being parsed as a time expression. Additionally, short Hebrew duration replies like "5 דקות" (without "בעוד") didn't parse because `parseRelativeDuration` requires the "בעוד" prefix. There was also no cancel/exit path.
- Fixed: replaced field-order routing with intent-detection routing — a new `tryParseReplyAsTime` helper tries `parseNaturalLanguageDate` directly, then with "בעוד " prepended (for short Hebrew forms like "5 דקות"), then with "in " prepended (for English short forms like "45 minutes"). If a `startAt` is produced, the reply fills `datetime`; otherwise it fills `text`. Added `looksLikeCancelReply` to detect exit phrases (לא משנה, עזוב, בטל, cancel, never mind, skip) and return an `OUT_OF_SCOPE` result that clears clarification state.
- Files changed: `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: add a single-unit Hebrew duration pattern to `parseRelativeDuration` in `time.ts` so "דקה" / "שעה" / "שעתיים" alone (without a leading number) parse correctly in clarification context.

## 2026-04-12 - Bug Fix: Reminder Parsing & Clarification Flow

- Fixed 5 bugs:
  1. Reminder intent losing to compose: added `&& !looksLikeReminderRequest` guard in both the `interpret` early-exit and `heuristicInterpretation` compose branch so reminder requests containing "אימייל" or "הודעה" no longer fall into compose.
  2. Broken reminder text extraction ("s לטלפן לאמא"): rewrote `inferReminderText` — Hebrew duration phrases are stripped explicitly in order (שעתיים → שעה → numeric) and English uses `minutes|minute` / `hours|hour` (longer alternative first) to prevent partial match leaving "s".
  3. Clarification continuation not working: implemented the missing `resumeClarification` private method on `OrchestratorService` — handles `SCHEDULE_MEETING` (re-parses time from reply, merges into payload) and `CREATE_REMINDER` (fills missing `text` or `startAt` from reply, loops back to clarify if still missing).
  4. Empty reminder treated as text: removed the `|| text.trim()` fallback from `inferReminderText` so an all-stripped result returns `""`, triggering the `"text"` missing-field path; clarification question now shows "על מה תרצה שאזכיר לך?" when text is missing vs. "מתי תרצה שאזכיר לך?" when time is missing.
  5. Fuzzy times resolving to the past: after `start.setHours(fuzzyHour, ...)` in `parseRelativeDate`, added a guard that advances to the next day when `start ≤ now`.
- Files changed: `src/services/llm-service.ts`, `src/services/orchestrator.ts`, `src/utils/time.ts`, `WORKLOG.md`
- Next follow-up: add unit tests covering all five fixed cases in `src/utils/time.test.ts` and a new `src/services/orchestrator.test.ts`.

## 2026-04-12 - Bug Fix: Google Calendar Reconnect Loop

- Root cause: when `createEvent` returned 401/403, the error was shown and a reconnect button offered, but the stale invalid tokens remained in `MemoryStore` (both in-memory map and persisted `data/google-tokens.json`). On the next confirm attempt the orchestrator re-loaded the same bad tokens and the request failed again immediately.
- Fixed: added `clearGoogleTokens(userId)` to `MemoryStore` (deletes from map + persists). In `orchestrator.confirm`, a try/catch around `calendar.createEvent` checks the new `googleAuthFailure` flag on the thrown error and calls `memory.clearGoogleTokens(userId)` before re-throwing. `CalendarService.createEvent` now sets both `calendarFailure = true` (all non-ok) and `googleAuthFailure = true` (401/403 only). Three structured logs added: token expiry logged before create, warn on token clear, info on token stored after OAuth callback.
- Files changed: `src/services/memory-store.ts`, `src/services/calendar-service.ts`, `src/services/orchestrator.ts`, `src/app.ts`, `WORKLOG.md`
- Next follow-up: implement token refresh using `refreshToken` before calendar calls so short-lived access tokens are renewed automatically instead of requiring a full reconnect.

## 2026-04-12 - Calendar Failure UX: Consistent Reconnect Button

- Implemented: All calendar API errors (create and update) now set `calendarFailure = true` on the thrown error (replacing the narrower `googleAuthFailure` 401/403-only flag). In `app.ts` the confirm-callback error handler now checks `calendarFailure` and sends a Hebrew message ("אירעה שגיאה בפעולת היומן. ניתן להתחבר מחדש ולנסות שוב.") with an inline "התחבר ליומן" button pointing to `/oauth/google/start`. The `skipped` path (no token at all) was also updated to send the same inline button instead of a plain-text URL.
- Files changed: `src/services/calendar-service.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: add a `deleteEvent` method to `CalendarService` with the same `calendarFailure` flag, and wire it into a `DELETE_EVENT` proposed action type.

- Central source file added: `src/supported-actions.ts`
- Files now using it: `src/types.ts`, `src/app.ts`, `src/services/orchestrator.ts`, `src/services/llm-service.ts`
- Still duplicated:
  - Legacy sample app action names in `src/services/action-registry.ts` (`create_lead`, `trigger_runbook`) do not yet use the central supported-name list.
  - Inline legacy intent/action string expectations remain in `src/app.test.ts` and `src/run-tests.ts`.

## 2026-04-12 - Bug Fix: Google Auth Failure UX

- Implemented: `createEvent` in `CalendarService` now marks thrown errors with `googleAuthFailure = true` when the Google API returns 401 or 403. The webhook confirm error handler checks for this flag and, if set, sends a specific Hebrew message with an inline "חבר מחדש את Google Calendar" button pointing to `/oauth/google/start`.
- Files changed: `src/services/calendar-service.ts`, `src/app.ts`, `WORKLOG.md`
- Next follow-up: clear stored (invalid) Google tokens when a 401 auth failure is detected, so stale tokens don't silently block future attempts.

## 2026-04-12 - Bug Fix: Confirm Button Loading Forever

- Root cause: `orchestrator.confirm()` or `calendarService.createEvent()` throwing an exception caused the webhook try/catch to call `next(error)` before `answerCallbackQuery` was ever reached — Telegram spinner stayed indefinitely.
- Fixed: wrapped the entire confirm block in its own try/catch with a `finally`-equivalent pattern ensuring `answerCallbackQuery` is always called (even on error, via `.catch(() => undefined)`). Added structured logs at each step: callback received, action loaded, calendar started, calendar done, callback answered. Added visible Telegram error messages on failure and on not-found.
- Files changed: `src/app.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next follow-up: investigate whether the Google Calendar API credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) are configured in `.env`, and verify the OAuth redirect URI matches the registered app.

## 2026-04-12 - Block Sequencing & Scope Discipline Step 1

- Implemented: added `OUT_OF_SCOPE` to `AGENT_INTENTS` and `AGENT_INTENT_VALUES`. Changed the heuristic fallback in `LlmService` from silently composing a draft (wrong scope) to returning `out_of_scope` intent with a neutral Hebrew reply. Updated `buildTelegramMarkup` to suppress buttons for `out_of_scope` the same way it does for `clarify`.
- Files changed: `src/supported-actions.ts`, `src/services/llm-service.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: add `looksLikeReminderRequest` and `looksLikeListRequest` heuristics in `llm-service.ts` so in-scope reminder and shopping-list inputs are recognised before the `out_of_scope` fallback fires.

## 2026-04-12 - Persistence Layer Step 1

- Implemented: set up PostgreSQL as the selected persistence backend by adding `pg`, introducing `DATABASE_URL` config, and adding a reusable `DatabaseService` bootstrap.
- Files changed: `.env.example`, `package.json`, `package-lock.json`, `src/app.ts`, `src/config.ts`, `src/services/database.ts`, `WORKLOG.md`
- Next step to implement: add the basic DB connection usage/check and start wiring the first persisted data path.

## 2026-04-12 - Shopping List Step 1

- Implemented: created the initial `ListService` foundation with shopping-list domain types and minimal list create/find/list methods.
- Files changed: `src/app.ts`, `src/types.ts`, `src/services/list-service.ts`, `WORKLOG.md`
- Next step to implement: add item insertion to a list, including support for single and multiple parsed items.

## 2026-04-12 - Shopping List Step 2

- Implemented: added `itemsByList` store and three methods to `ListService`: `listItems(listId)`, `addItem(listId, text)`, `addItems(listId, texts[])`.
- Files changed: `src/services/list-service.ts`, `WORKLOG.md`
- Next step to implement: add heuristic detection of list requests in `llm-service.ts` (`looksLikeListRequest`) and return an `add_to_list` intent with parsed items so the bot can actually respond to shopping-list messages.

## 2026-04-12 - Reminders Step 1

- Implemented: created the initial `ReminderService` foundation with reminder domain types and minimal reminder create/get/list methods.
- Files changed: `src/app.ts`, `src/types.ts`, `src/services/reminder-service.ts`, `WORKLOG.md`
- Next step to implement: add time parsing support for exact, relative, and fuzzy reminder inputs.

## 2026-04-12 - Reminders Step 2

- Implemented: added `CREATE_REMINDER` to `PROPOSED_ACTION_TYPES` and `AGENT_INTENT_VALUES`; added `ReminderRequest` type; added `looksLikeReminderRequest` heuristic and `inferReminderText` helper in `llm-service.ts`; wired the reminder interpretation path with time parsing, clarify fallback, and draft response.
- Files changed: `src/supported-actions.ts`, `src/types.ts`, `src/services/llm-service.ts`, `WORKLOG.md`
- Next step to implement: handle `CREATE_REMINDER` in the orchestrator `confirm` method so confirming a reminder actually calls `ReminderService.createReminder`.

## 2026-04-12 - Reminder Execution Engine Step 1

- Implemented: added due-reminder lookup, sent-status updates, and a minimal `ReminderExecutionEngine` that executes due reminders through a callback.
- Files changed: `src/app.ts`, `src/services/reminder-service.ts`, `src/services/reminder-execution-engine.ts`, `WORKLOG.md`
- Next step to implement: add a polling trigger that uses the engine to send due reminders through Telegram.

## 2026-04-12 - Clarification & UX Step 1

- Implemented: added a neutral clarification-state foundation so missing-field clarification context can be stored and cleared per user.
- Files changed: `src/types.ts`, `src/services/memory-store.ts`, `src/services/orchestrator.ts`, `WORKLOG.md`
- Next step to implement: use the stored clarification context to resume the pending action when the user replies with missing data.

## 2026-04-12 - Calendar Enhancements Step 1

- Implemented: improved fuzzy calendar time parsing by mapping morning, afternoon, and evening phrases for supported relative day references to concrete hours.
- Files changed: `src/utils/time.ts`, `src/run-tests.ts`, `WORKLOG.md`
- Next step to implement: add calendar update event flow.

## 2026-04-12 - Time Parsing Engine Step 1

- Implemented: added `parseRelativeDuration` to handle "in X minutes/hours" (English) and "בעוד X דקות/שעות/שעה/שעתיים" (Hebrew) patterns in `parseNaturalLanguageDate`. This runs before explicit and relative date parsing, returning a concrete `startAt` ISO string offset from `now`.
- Files changed: `src/utils/time.ts`, `WORKLOG.md`
- Next step to implement: add 12-hour AM/PM time format parsing ("3pm", "3:30pm") as a standalone time component that can combine with existing date resolvers.

## 2026-04-12 - Time Parsing Engine Step 2

- Implemented: added `parseAmPmTime` helper that extracts 12-hour clock times ("3pm", "3:30pm", "10am") and converts them to 24-hour `{ hour, minute }`. Integrated into `parseRelativeDate` — AM/PM takes precedence over the `בשעה`/`at` pattern, giving a confidence of 0.9 when matched.
- Files changed: `src/utils/time.ts`, `WORKLOG.md`
- Next step to implement: add validation bounds to `parseExplicitDate` (reject day > 31 or month > 12) to prevent silent production of invalid Date objects from malformed input.

## 2026-04-12 - Deployment Readiness Step 1

- Implemented: added a two-stage `Dockerfile` (builder compiles TypeScript, runtime runs `dist/server.js` on `node:22-alpine` with prod-only deps) and a `.dockerignore` excluding `node_modules`, `dist`, `.env`, and `data`.
- Files changed: `Dockerfile`, `.dockerignore`, `WORKLOG.md`
- Next step to implement: add a `docker-compose.yml` that wires the bot container with a Postgres service and maps the required env vars.

## 2026-04-12 - Testing Step 1

- Implemented: created `src/utils/time.test.ts` with 10 unit tests covering explicit dates, relative day/time phrases, and "in X minutes/hours" duration parsing using `node:test`. Updated `package.json` `test` script to run via Node's built-in `--test` runner over `time.test.ts` and the existing `app.test.ts`.
- Files changed: `src/utils/time.test.ts`, `package.json`, `WORKLOG.md`
- Next step to implement: add unit tests for `ReminderService` (create, list, listDueReminders, markReminderSent) as a pure in-memory service with no network dependencies.

## 2026-04-12 - Error Handling & Reliability Step 1

- Implemented: distinguished `ZodError` from unexpected errors in the global Express error handler — validation failures now return HTTP 400 with a structured `issues` array instead of 500.
- Files changed: `src/app.ts`, `WORKLOG.md`
- Next step to implement: add process-level `unhandledRejection` and `uncaughtException` handlers in `server.ts` so unhandled async failures are logged and the process exits cleanly.

## 2026-04-12 - Observability Step 1

- Implemented: created `src/utils/logger.ts` with a structured JSON logger (`info`, `warn`, `error`) that writes to stdout/stderr. Wired it into server startup and the Express error handler.
- Files changed: `src/utils/logger.ts`, `src/server.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: add per-request logging middleware (method, path, status, duration) to capture all HTTP traffic.

## 2026-04-12 - WORKLOG System Step 1

- Implemented: added `WorklogEntry` type and `WorklogAction` union to `types.ts`, created `WorklogService` with `record` and `list` methods, and registered it in `createApp`.
- Files changed: `src/types.ts`, `src/services/worklog-service.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: call `worklog.record(...)` after confirmed actions (reminder created, calendar event created, list item added) so entries are populated.

## 2026-04-12 - Telegram UX Improvements Step 1

- Implemented: added optional `parseMode` parameter (`"HTML" | "MarkdownV2"`) to `TelegramService.sendMessage`, and wired `"HTML"` as the parse mode for all agent-reply messages sent via the webhook handler.
- Files changed: `src/services/telegram-service.ts`, `src/app.ts`, `WORKLOG.md`
- Next step to implement: escape HTML special characters in `draftResponse` before sending, so user-provided text doesn't break HTML formatting.
