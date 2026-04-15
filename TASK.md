# TASK.md — Smart Telegram AI Assistant (Execution-Ready)

## ⚠️ GLOBAL RULES (APPLIES TO ALL TASKS)

- Read MVP.md and TASK.md first
- Read CLAUDE.md and docs/CODEBASE_MAP.md first
- Do NOT explore full codebase
- Only open files you explicitly list
- Keep tasks minimal
- Do NOT refactor unrelated code
- Always update WORKLOG.md
- Always state files BEFORE opening them

---

# 🧠 TASK 1.1 — Create LLM Client

Goal:
Create minimal Groq LLM client

Instructions:

1. List which file you will add this to
2. Do NOT open any files yet

3. Create function:

createChatCompletion(input: string): Promise<string>

4. Requirements:
- Use fetch
- Endpoint: https://api.groq.com/openai/v1/chat/completions
- Model: llama3-8b-8192
- Use GROQ_API_KEY from env

5. System prompt:
"You are a helpful assistant. Respond in Hebrew, short and clear."

6. Return:
- assistant message only

7. Error handling:
Return:
"מצטער, הייתה בעיה זמנית. נסה שוב."

8. Do NOT integrate anywhere yet

9. Update WORKLOG.md

---

# 🧠 TASK 1.2 — Test LLM Client

Goal:
Verify LLM client works

Instructions:

1. Use the function created in previous task
2. Call it with simple input:
"מה זה חמצן?"

3. Log result to console

4. Do NOT integrate into system yet

5. Update WORKLOG.md

---

# 🧠 TASK 2.1 — Route Message to LLM

Goal:
Send user input to LLM (without removing old system)

Instructions:

1. Identify orchestrator entry point
2. List files BEFORE opening

3. Add temporary path:
- Receive user text
- Call createChatCompletion
- Return response

4. Do NOT remove existing intent logic

5. Keep both systems working

6. Update WORKLOG.md

---

# 🧠 TASK 2.2 — Use LLM as Primary Response

Goal:
Make LLM response the main output

Instructions:

1. Modify orchestrator response
2. Ensure:
- LLM response is returned to user
- Old system still exists but is secondary

3. Do NOT delete old logic yet

4. Update WORKLOG.md

---

# 🧠 TASK 3.1 — Detect Reminder Intent

Goal:
Detect explicit reminder requests only

Instructions:

1. Add detection logic:
- "תזכיר לי"
- "תזכורת"

2. Do NOT detect implicit intents

3. Return structured object:
{
  type: "reminder",
  text: string,
  datetime?: string
}

4. Do NOT execute anything

5. Update WORKLOG.md

---

# 🧠 TASK 3.2 — Attach suggestedAction

Goal:
Attach action suggestion to response

Instructions:

1. Extend response structure:

{
  message: string,
  suggestedAction?: {...}
}

2. If reminder detected:
- attach suggestedAction

3. Do NOT change UI yet

4. Update WORKLOG.md

---

# 🧠 TASK 4.1 — Create Pending Action Store

Goal:
Store pending actions

Instructions:

1. Add in-memory store
2. Map:
userId → action

3. Generate action ID

4. Do NOT persist yet

5. Update WORKLOG.md

---

# 🧠 TASK 4.2 — Add Confirm/Cancel Buttons

Goal:
Add Telegram buttons

Instructions:

1. Modify Telegram response
2. Add:
- Confirm
- Cancel

3. Use short ASCII callback_data

4. Update WORKLOG.md

---

# 🧠 TASK 4.3 — Handle Confirmation

Goal:
Handle user confirmation

Instructions:

1. Detect callback_query
2. Match action ID
3. Route:
- Confirm → execute
- Cancel → delete

4. Update WORKLOG.md

---

# 🧠 TASK 5.1 — Execute Reminder

Goal:
Execute reminder after confirm

Instructions:

1. Call reminder service
2. Store reminder
3. Return success message

4. Update WORKLOG.md

---

# 🧠 TASK 6.1 — Add List Item

Goal:
Add item to list

Instructions:

1. Detect explicit list request
2. Call list service
3. Add item

4. Update WORKLOG.md

---

# 🧠 TASK 7.1 — Store Conversation

Goal:
Store short conversation history

Instructions:

1. Store last 5 messages
2. Include:
- user
- assistant

3. Update WORKLOG.md

---

# 🧠 TASK 7.2 — Send Context to LLM

Goal:
Improve responses

Instructions:

1. Send message history to LLM
2. Limit size

3. Update WORKLOG.md

---

# 🧠 TASK 8.1 — Error Handling

Goal:
Prevent crashes

Instructions:

1. Wrap LLM calls in try/catch
2. Wrap action execution

3. Update WORKLOG.md

---

# 🧠 TASK 8.2 — Fallback Message

Goal:
Safe fallback

Instructions:

Return:
"משהו השתבש, נסה שוב"

---

# 🧠 FINAL RULE

Never jump between tasks  
Always complete one fully before moving forward