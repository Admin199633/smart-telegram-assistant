import type { AgentIntent, ProposedActionType } from "./supported-actions.js";

export type Intent = AgentIntent;

export type Tone = "personal" | "business";

export interface SchedulingPreferences {
  timezone: string;
  preferredHours?: string[];
}

export interface UserProfile {
  userId: string;
  language: string;
  tonePreferences: {
    defaultTone: Tone;
    supportsDualTone: boolean;
  };
  frequentContacts: string[];
  schedulingPreferences: SchedulingPreferences;
}

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface CalendarRequest {
  title: string;
  participants: string[];
  startAt?: string;
  endAt?: string;
  inferredTimeText?: string;
  confidence: number;
  notes?: string;
}

export type ListItemStatus = "active" | "completed";

export interface ShoppingList {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ShoppingListItem {
  id: string;
  listId: string;
  text: string;
  status: ListItemStatus;
  createdAt: string;
}

export type ReminderStatus = "pending" | "sent";

export interface Reminder {
  id: string;
  userId: string;
  chatId?: number;
  text: string;
  datetime: string;
  status: ReminderStatus;
  createdAt: string;
}

export interface ReminderRequest {
  text: string;
  datetime?: string;
  inferredTimeText?: string;
}

export interface CreateListRequest {
  listName: string;
}

export interface ListRequest {
  items: string[];
  listName?: string;
  targetListId?: string;
  createIfMissing?: boolean;
}

export interface RemoveFromListRequest {
  index: number;
  listName?: string;
  targetListId?: string;
}

export interface DeleteListRequest {
  listName: string;
  listId?: string;
}

export interface DeleteReminderRequest {
  reminderId: string;
  reminderText: string;
}

export interface SnoozeReminderRequest {
  reminderId: string;
  reminderText: string;
  newDatetime: string;
}

export interface AppActionRequest {
  appKey: string;
  actionName: string;
  inputs: Record<string, unknown>;
  confirmationText: string;
}

export interface ComposeVariant {
  label: string;
  content: string;
}

export interface ComposeDraftPayload {
  tone: Tone;
  content: string;
  variants: ComposeVariant[];
}

export interface ProposedAction<TPayload = unknown> {
  id: string;
  type: ProposedActionType;
  summary: string;
  requiresConfirmation: boolean;
  payload: TPayload;
  missingFields?: string[];
}

export interface ClarificationState {
  userId: string;
  action: ProposedAction;
  missingFields: string[];
  question: string;
  createdAt: string;
}

export interface AgentInterpretation {
  intent: Intent;
  entities: Record<string, unknown>;
  draftResponse: string;
  proposedAction?: ProposedAction;
}

export interface PendingEscalation {
  originalMessage: string;
  sourceModel: string;
  targetModel: string;
  createdAt: string;
}

export interface ConfirmationResult {
  status: "completed" | "rejected" | "not_found";
  message: string;
  result?: unknown;
}

export type WorklogAction =
  | "reminder_created"
  | "calendar_event_created"
  | "list_item_added"
  | "list_created"
  | "reminder_sent";

export interface WorklogEntry {
  id: string;
  userId: string;
  action: WorklogAction;
  summary: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  type: "interpretation" | "confirmation" | "telegram_update";
  userId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ActionDefinition {
  appKey: string;
  actionName: string;
  description: string;
  inputSchema: Record<string, string>;
  confirmationText: string;
  executionEndpoint: string;
  method?: "GET" | "POST" | "PUT";
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuthState {
  userId: string;
  chatId?: number;
  createdAt: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: {
      id: number;
      first_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: {
      id: number;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
      };
    };
  };
}
