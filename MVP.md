# Smart Telegram Assistant - MVP Specification

## 🎯 Product Definition

A personal Telegram-based assistant for managing: - Calendar events -
Shopping and task lists - Reminders

The assistant acts as a single control layer for daily personal
management using natural language in Hebrew.

------------------------------------------------------------------------

## 👤 Target User

-   Single user (personal use)
-   Heavy Telegram user
-   Currently manages tasks across notes, calendar, and other apps

------------------------------------------------------------------------

## 🧠 Core Capabilities

### 1. Calendar Management

Supported actions: - Create event - Update event - Delete event - View
events (e.g., "what do I have today")

Input handling: - Exact time ("tomorrow at 17:00") - Fuzzy time
("tomorrow evening" → mapped automatically)

Behavior: - Default: no participants - Optional: allow adding
participants - If multiple matching events → show options to user

------------------------------------------------------------------------

### 2. Shopping & Task Lists

Supported actions: - Add item(s) to list (multiple in one command) -
View list - Mark item as completed - View completed items - Remove items

List behavior: - Multiple lists supported - If list does not exist → ask
user and suggest up to 3 recent lists - If no list specified → system
infers intent (shopping vs tasks)

List structure: - Active items (not completed) - Completed items
(viewable separately)

------------------------------------------------------------------------

### 3. Reminders

Supported actions: - Create reminder - View reminders

Input handling: - Exact time - Relative time ("in one hour") - Fuzzy
time ("tomorrow morning/evening")

Behavior: - One-time reminders only (MVP) - Fuzzy times auto-mapped: -
Morning → 09:00 - Afternoon → 13:00 - Evening → 19:00

Execution: - Sends Telegram message at trigger time

------------------------------------------------------------------------

## 💬 UX Rules

-   Every action requires explicit confirmation
-   If missing information → ask clarification
-   Never guess critical data
-   Responses should be concise and clear

------------------------------------------------------------------------

## 🔄 Core Flows

### Calendar

User → Parse → Clarify (if needed) → Confirm → Execute → Response

### Lists

User → Parse → Infer list → Confirm → Store → Response

### Reminders

User → Parse → Normalize time → Confirm → Store → Trigger → Notify

------------------------------------------------------------------------

## 🧱 System Architecture (High Level)

-   Telegram Webhook (entry point)
-   Orchestrator (flow manager)
-   LLM Service (intent parsing)
-   Calendar Service (Google Calendar)
-   List Service (new)
-   Reminder Service (new)
-   Persistence Layer (DB required)

------------------------------------------------------------------------

## 🧱 Data Requirements

### User

-   id
-   telegram_id
-   timezone

### Lists

-   id
-   user_id
-   name
-   created_at

### List Items

-   id
-   list_id
-   text
-   status (active/completed)
-   created_at

### Reminders

-   id
-   user_id
-   text
-   datetime
-   status
-   created_at

### Calendar Tokens

-   user_id
-   access_token
-   refresh_token

------------------------------------------------------------------------

## ⚠️ Constraints

-   Single-user system (no multi-user complexity)
-   No SaaS features
-   Minimal infrastructure
-   Focus on reliability over features

------------------------------------------------------------------------

## ✅ Definition of Done (MVP)

-   User can create/update/delete calendar events
-   User can manage lists (add/view/complete)
-   User can create reminders with natural language
-   Reminders trigger correctly via Telegram
-   System handles fuzzy time
-   All actions require confirmation
-   Data persists (no memory-only)

------------------------------------------------------------------------

## 🚀 Future (Not in MVP)

-   Recurring reminders
-   Shared lists
-   Multi-user support
-   Admin UI
-   Advanced integrations
