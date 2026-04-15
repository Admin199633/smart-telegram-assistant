# MVP - Smart Telegram AI Assistant (v2)

## Product Definition
A Telegram-based AI assistant that enables:
- Free-form conversation in Hebrew
- Basic text understanding (summaries, explanations, writing help)
- Execution of personal actions (reminders, lists, calendar)

Core principle:
**Conversation is primary. Actions are secondary.**

## Target User
- Single user (MVP)
- Heavy Telegram user
- Needs a single place to think, ask, and manage tasks

## Core Capabilities

### AI Conversation (Primary)
- Answer general questions
- Explain simple concepts
- Summarize text
- Assist with writing

Requirements:
- Natural Hebrew responses
- Clear and concise
- No hallucinated actions

### Conversation Behavior
Default:
User → AI Response

No forced commands or rigid flows.

### Action Suggestion (Secondary)
Triggered only on explicit user request.

Supported:
- Reminders
- Lists
- Calendar events

Flow:
User → Detect → Suggest → Confirm

### Confirmation System
All actions require explicit confirmation.

### Action Execution
Reminders:
- Create
- Store datetime
- Trigger message

Lists:
- Create
- Add items
- View items
- Mark completed

Calendar:
- Create / view / update / delete

## UX Principles
- Conversation-first
- Clear separation between chat and actions
- Minimal friction
- Safe system behavior

## System Architecture
Telegram → Webhook → Orchestrator → LLM → Response → (Optional Action) → Confirmation → Execution

## Data Model
User, Reminder, List, ListItem, PendingAction

## Constraints
- Single user
- No long-term AI memory
- No autonomous actions
- Minimal infrastructure

## Definition of Done
- Conversation works
- Actions work
- Confirmation required
- Stable system

## Non-Goals
- GPT-level intelligence
- Multi-user
- Advanced memory
- Automation
