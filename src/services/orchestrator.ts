import { AGENT_INTENTS, PROPOSED_ACTION_TYPES } from "../supported-actions.js";
import { AgentInterpretation, CalendarRequest, ClarificationState, ConfirmationResult, CreateListRequest, DeleteListRequest, DeleteReminderRequest, ListRequest, ProposedAction, RemoveFromListRequest, ReminderRequest, SnoozeReminderRequest } from "../types.js";
import {
  normalizeInput,
  matchesAny,
  MEETING_TRIGGERS,
  CALENDAR_VIEW_TRIGGERS,
  REMINDER_TRIGGERS,
  REMINDER_VIEW_TRIGGERS,
  REMINDER_DELETE_TRIGGERS,
  REMINDER_SNOOZE_TRIGGERS,
  LIST_ADD_TRIGGERS,
  LIST_VIEW_TRIGGERS,
  LIST_VIEW_ALL_TRIGGERS,
  LIST_REMOVE_TRIGGERS,
  CREATE_LIST_TRIGGERS,
  DELETE_LIST_TRIGGERS,
  DELETE_LIST_BARE_TRIGGERS
} from "../utils/normalize.js";
import { createId } from "../utils/id.js";
import { formatDateTime, parseNaturalLanguageDate, ParsedTimeResult } from "../utils/time.js";
import { AppActionService } from "./app-action-service.js";
import { CalendarService } from "./calendar-service.js";
import { ListService } from "./list-service.js";
import { LlmService } from "./llm-service.js";
import { MemoryStore } from "./memory-store.js";
import { ReminderService } from "./reminder-service.js";
import { logger } from "../utils/logger.js";
import { escalateToGroq } from "./smart-chat.js";

const GROQ_ATTRIBUTION = "תשובה מ-GROQ:";

export class OrchestratorService {
  constructor(
    private readonly memory: MemoryStore,
    private readonly llm: LlmService,
    private readonly calendar: CalendarService,
    private readonly appActions: AppActionService,
    private readonly defaultTimezone: string,
    private readonly reminderService?: ReminderService,
    private readonly listService?: ListService
  ) {}

  async interpret(userId: string, text: string): Promise<AgentInterpretation> {
    const profile = this.memory.getOrCreateProfile(userId, this.defaultTimezone);

    const clarification = this.memory.getClarification(userId);
    if (clarification) {
      this.clearPendingConfirmationState(userId);
      const normalizedForCheck = normalizeInput(text);
      // When the user is answering "which list?", list-name replies (e.g. "קניות",
      // "לקניות") match LIST_ADD_TRIGGERS and would falsely interrupt the flow.
      // Skip the new-intent check so clarification resume handles them correctly.
      const skipNewIntentCheck =
        (clarification.action.type === PROPOSED_ACTION_TYPES.ADD_TO_LIST &&
          clarification.missingFields.includes("listId")) ||
        (clarification.action.type === PROPOSED_ACTION_TYPES.DELETE_LIST &&
          clarification.missingFields.includes("listName"));
      if (!skipNewIntentCheck && looksLikeNewIntent(normalizedForCheck)) {
        // User sent a clearly new request — abandon the active clarification
        this.memory.clearClarification(userId);
        logger.info("clarification interrupted by new intent", { userId, actionType: clarification.action.type });
        // fall through to normal routing below
      } else if (
        clarification.action.type === PROPOSED_ACTION_TYPES.ADD_TO_LIST &&
        !clarification.missingFields.includes("listId") &&
        !clarification.missingFields.includes("createList") &&
        !isValidListItem(text)
      ) {
        this.memory.clearClarification(userId);
        logger.info("list continuation escaped — input not a valid list item", { userId });
        // fall through to normal routing below
      } else {
      logger.info("routing: clarification", { userId, actionType: clarification.action.type, missingFields: clarification.missingFields });
      const resumed = this.resumeClarification(clarification, text, profile.schedulingPreferences.timezone);
      const resolvedResumed = this.resolveListForInterpretation(userId, resumed);
      const now = new Date().toISOString();

      this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
      this.memory.appendConversation(userId, { role: "assistant", content: resolvedResumed.draftResponse, createdAt: now });
      this.syncConversationalState(userId, resolvedResumed, now);

      this.memory.addAuditEntry({
        id: createId("audit"),
        type: "interpretation",
        userId,
        payload: { text, interpretation: resolvedResumed, resumed: true },
        createdAt: now
      });

      resolvedResumed.engine ??= "FEATURE";
      return resolvedResumed;
      } // end else (not a new intent)
    }

    // Text-based confirmation: intercept "כן"/"לא" when a pending action is waiting for this user
    const pendingActionId = this.memory.getPendingActionIdForUser(userId);
    if (pendingActionId) {
      const pendingAction = this.memory.getPendingAction(pendingActionId);
      if (!pendingAction) {
        this.memory.clearPendingActionUser(userId);
        logger.info("routing: cleared stale confirmation", { userId, actionId: pendingActionId });
      } else {
        logger.info("routing: confirmation", { userId, actionId: pendingActionId });
        if (looksLikeTextConfirm(text)) {
          const result = await this.confirm(userId, pendingActionId);
          this.memory.appendConversation(userId, { role: "user", content: text, createdAt: new Date().toISOString() });
          this.memory.appendConversation(userId, { role: "assistant", content: result.message, createdAt: new Date().toISOString() });
          return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: result.message, engine: "FEATURE" };
        }
        if (looksLikeTextCancel(text)) {
          this.clearPendingConfirmationState(userId);
          this.memory.clearClarification(userId);
          this.memory.appendConversation(userId, { role: "user", content: text, createdAt: new Date().toISOString() });
          this.memory.appendConversation(userId, { role: "assistant", content: "בוטל.", createdAt: new Date().toISOString() });
          return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: "בוטל.", engine: "FEATURE" };
        }

        this.clearPendingConfirmationState(userId);
        logger.info("routing: confirmation cleared on new message", { userId, actionId: pendingActionId });
      }
    }

    // Pending GROQ escalation: user was offered a switch after a Gemini refusal
    const pendingEscalation = this.memory.getPendingEscalation(userId);
    if (pendingEscalation) {
      if (looksLikeTextConfirm(text)) {
        this.memory.clearPendingEscalation(userId);
        logger.info("routing: GROQ escalation approved", { userId });
        const groqResponse = await escalateToGroq(pendingEscalation.originalMessage);
        const response = `${GROQ_ATTRIBUTION}\n${groqResponse}`;
        const now = new Date().toISOString();
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: response, engine: "GROQ" };
      }
      if (looksLikeTextCancel(text)) {
        this.memory.clearPendingEscalation(userId);
        logger.info("routing: GROQ escalation declined", { userId });
        const response = "בסדר, אני כאן אם תצטרך משהו אחר.";
        const now = new Date().toISOString();
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: response, engine: "FEATURE" };
      }
      // Neither yes nor no — user moved on; clear the offer and route normally
      this.memory.clearPendingEscalation(userId);
      logger.info("routing: GROQ escalation expired on new message", { userId });
    }

    // Numbered list reference resolution: intercept before LLM when the user
    // refers to a list by number or ordinal after seeing a numbered list of lists.
    const listRefIndex = tryResolveNumberedListReference(text);
    if (listRefIndex !== undefined && this.listService) {
      const listContext = this.memory.getNumberedListContext(userId);
      const contextValid = listContext &&
        Date.now() - new Date(listContext.timestamp).getTime() <= 5 * 60 * 1000;

      if (contextValid) {
        const now = new Date().toISOString();
        if (listRefIndex < 0 || listRefIndex >= listContext.items.length) {
          const response = `מספר לא תקין. יש לך ${listContext.items.length} רשימות.`;
          this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
          this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
          return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: response, engine: "FEATURE" };
        }
        const resolvedName = listContext.items[listRefIndex];
        const list = this.listService.findListByName(userId, resolvedName);
        let response: string;
        if (!list) {
          response = `לא מצאתי רשימה בשם "${resolvedName}".`;
        } else {
          const items = this.listService.listItems(list.id).filter((i) => i.status === "active");
          response = items.length === 0
            ? `רשימת ${list.name} ריקה כרגע.`
            : `רשימת ${list.name}:\n${items.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n")}`;
        }
        logger.info("routing: numbered list reference resolved", { userId, index: listRefIndex, resolvedName });
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.VIEW_LIST, entities: { listName: resolvedName }, draftResponse: response, engine: "FEATURE" };
      }

      // Explicit list-view reference (has a view prefix) but no valid context —
      // return a helpful FEATURE response instead of falling through to Gemini.
      if (isExplicitListViewReference(text)) {
        const now = new Date().toISOString();
        const response = "לא הבנתי לאיזו רשימה אתה מתכוון. תוכל לבקש לראות את הרשימות שלך קודם?";
        logger.info("routing: explicit list reference without context", { userId });
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: response, engine: "FEATURE" };
      }
    }

    // Deterministic view-list intercept: catch unambiguous view phrases before
    // the LLM call so AI misclassification cannot route them to ADD or CREATE.
    const normalizedForView = normalizeInput(text);
    if (this.listService) {
      if (matchesAny(normalizedForView, LIST_VIEW_ALL_TRIGGERS)) {
        logger.info("routing: deterministic VIEW_LISTS", { userId });
        const lists = this.listService.listLists(userId);
        const now = new Date().toISOString();
        let response: string;
        if (lists.length === 0) {
          response = "אין לך עדיין רשימות שמורות.";
          this.memory.clearNumberedListContext(userId);
        } else {
          response = `הרשימות שלך:\n${lists.map((l, idx) => `${idx + 1}. ${l.name}`).join("\n")}`;
          this.memory.saveNumberedListContext(userId, {
            type: "lists",
            items: lists.map((l) => l.name),
            timestamp: now
          });
        }
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.VIEW_LISTS, entities: {}, draftResponse: response, engine: "FEATURE" };
      }

      if (matchesAny(normalizedForView, LIST_VIEW_TRIGGERS)) {
        logger.info("routing: deterministic VIEW_LIST", { userId });
        const listName = inferViewListName(normalizedForView);
        const list = listName
          ? this.listService.findListByName(userId, listName)
          : this.listService.listLists(userId)[0];
        let response: string;
        if (!list) {
          response = listName
            ? `לא מצאתי רשימה בשם "${listName}".`
            : "אין לך עדיין רשימות שמורות.";
        } else {
          const items = this.listService.listItems(list.id).filter((i) => i.status === "active");
          response = items.length === 0
            ? `רשימת ${list.name} ריקה כרגע.`
            : `רשימת ${list.name}:\n${items.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n")}`;
        }
        const now = new Date().toISOString();
        this.memory.appendConversation(userId, { role: "user", content: text, createdAt: now });
        this.memory.appendConversation(userId, { role: "assistant", content: response, createdAt: now });
        return { intent: AGENT_INTENTS.VIEW_LIST, entities: { listName }, draftResponse: response, engine: "FEATURE" };
      }
    }

    logger.info("routing: ai", { userId });
    const conversation = this.memory.listConversation(userId);
    const interpretation = await this.llm.interpret({
      userId,
      text,
      profile,
      conversation
    });

    if (interpretation.intent === AGENT_INTENTS.VIEW_LIST && this.listService) {
      const listName = interpretation.entities.listName as string | undefined;
      const list = listName
        ? this.listService.findListByName(userId, listName)
        : this.listService.listLists(userId)[0];
      if (!list) {
        interpretation.draftResponse = listName
          ? `לא מצאתי רשימה בשם "${listName}".`
          : "אין לך עדיין רשימות שמורות.";
      } else {
        const items = this.listService.listItems(list.id).filter((i) => i.status === "active");
        interpretation.draftResponse = items.length === 0
          ? `רשימת ${list.name} ריקה כרגע.`
          : `רשימת ${list.name}:\n${items.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n")}`;
      }
    }

    if (interpretation.intent === AGENT_INTENTS.VIEW_LISTS && this.listService) {
      const lists = this.listService.listLists(userId);
      if (lists.length === 0) {
        interpretation.draftResponse = "אין לך עדיין רשימות שמורות.";
        this.memory.clearNumberedListContext(userId);
      } else {
        interpretation.draftResponse = `הרשימות שלך:\n${lists.map((l, idx) => `${idx + 1}. ${l.name}`).join("\n")}`;
        this.memory.saveNumberedListContext(userId, {
          type: "lists",
          items: lists.map((l) => l.name),
          timestamp: new Date().toISOString()
        });
      }
    }

    if (interpretation.intent === AGENT_INTENTS.DELETE_LIST && this.listService) {
      const payload = interpretation.proposedAction?.payload as DeleteListRequest | undefined;
      if (payload?.listName) {
        const list = this.listService.findListByName(userId, payload.listName);
        if (!list) {
          interpretation.intent = AGENT_INTENTS.OUT_OF_SCOPE;
          interpretation.draftResponse = `לא מצאתי רשימה בשם "${payload.listName}".`;
          interpretation.proposedAction = undefined;
        } else {
          interpretation.proposedAction = {
            ...interpretation.proposedAction!,
            payload: { ...payload, listId: list.id }
          };
        }
      }
    }

    if (interpretation.intent === AGENT_INTENTS.VIEW_REMINDERS && this.reminderService) {
      const timezone = profile.schedulingPreferences.timezone;
      const pending = this.reminderService
        .listReminders(userId)
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
      if (pending.length === 0) {
        interpretation.draftResponse = "אין לך תזכורות פעילות כרגע.";
      } else {
        const lines = pending.map((r, idx) => {
          const label = reminderDayLabel(r.datetime, timezone);
          const time = formatDateTime(r.datetime, "he-IL", timezone);
          return `${idx + 1}. ${r.text} — ${label ? `${label}, ` : ""}${time}`;
        });
        interpretation.draftResponse =
          `התזכורות שלך:\n${lines.join("\n")}\n\nלמחיקה: "מחק תזכורת 1" | לדחייה: "דחה תזכורת 1 לשעה X"`;
      }
    }

    // Shopping-list continuation: if the last bot message was a list response and the
    // current input is item-like text that went unmatched (OUT_OF_SCOPE), keep adding.
    if (interpretation.intent === AGENT_INTENTS.OUT_OF_SCOPE) {
      const lastBotContent = [...conversation].reverse().find((t) => t.role === "assistant")?.content ?? "";
      if (/(?:לרשימת|רשימת)/.test(lastBotContent)) {
        const listNameMatch = lastBotContent.match(/(?:לרשימת|רשימת)\s+(ה?[\u0590-\u05FF]+)/);
        const continuationListName = (listNameMatch?.[1] ?? "קניות").replace(/^ה/, "");
        const items = text
          .split(/[\n,،]+/)
          .map((i) => i.replace(/^ו+/, "").replace(/^גם\s+/u, "").trim())
          .filter((i) => i.length > 0 && !/^(?:כן|yes|אוקי|בסדר|לא|בטל|ביטול|cancel|עזוב|להציג|הצג|תציג|תיצור|רשימה)/i.test(i));
        if (items.length > 0) {
          const contAction: ProposedAction<ListRequest> = {
            id: createId("list"),
            type: PROPOSED_ACTION_TYPES.ADD_TO_LIST,
            summary: `הוספה לרשימת ${continuationListName}`,
            requiresConfirmation: true,
            payload: { items, listName: continuationListName },
            missingFields: []
          };
          interpretation.intent = AGENT_INTENTS.ADD_TO_LIST;
          interpretation.entities = { items };
          interpretation.draftResponse = `להוסיף לרשימת ${continuationListName}: ${items.join(", ")}?`;
          interpretation.proposedAction = contAction;
        }
      }
    }

    const resolved = this.resolveListForInterpretation(userId, interpretation);
    const now = new Date().toISOString();

    // Save escalation state so the next message can handle yes/no
    if (resolved.isRefusalOffer) {
      this.memory.savePendingEscalation(userId, {
        originalMessage: text,
        sourceModel: "gemini",
        targetModel: "groq",
        createdAt: now
      });
      logger.info("routing: GROQ switch offered after refusal", { userId });
    }

    this.memory.appendConversation(userId, {
      role: "user",
      content: text,
      createdAt: now
    });
    this.memory.appendConversation(userId, {
      role: "assistant",
      content: resolved.draftResponse,
      createdAt: now
    });

    this.syncConversationalState(userId, resolved, now);

    this.memory.addAuditEntry({
      id: createId("audit"),
      type: "interpretation",
      userId,
      payload: {
        text,
        interpretation: resolved
      },
      createdAt: now
    });

    return resolved;
  }

  async confirm(userId: string, actionId: string, chatId?: number): Promise<ConfirmationResult> {
    const action = this.memory.getPendingAction(actionId);
    if (!action) {
      return {
        status: "not_found",
        message: "לא מצאתי פעולה ממתינה לאישור."
      };
    }

    logger.info("confirm action loaded", { userId, actionId, actionType: action.type });

    let result: unknown;
    if (action.type === PROPOSED_ACTION_TYPES.SCHEDULE_MEETING) {
      const tokens = this.memory.getGoogleTokens(userId);
      logger.info("calendar create started", { userId, hasToken: Boolean(tokens?.accessToken), tokenExpiry: tokens?.expiryDate ?? null });
      try {
        result = await this.calendar.createEvent(action.payload as never, tokens?.accessToken);
      } catch (calendarError) {
        const isAuthFailure = calendarError instanceof Error &&
          (calendarError as Error & { googleAuthFailure?: boolean }).googleAuthFailure === true;
        if (isAuthFailure) {
          this.memory.clearGoogleTokens(userId);
          logger.warn("google tokens cleared on auth failure", { userId });
        }
        throw calendarError;
      }
      const status = (result as Record<string, unknown>).status ?? "created";
      logger.info("calendar create done", { userId, status });
    } else if (action.type === PROPOSED_ACTION_TYPES.CREATE_REMINDER) {
      const payload = action.payload as ReminderRequest;
      if (!payload.datetime) {
        return {
          status: "rejected",
          message: "לא ניתן ליצור תזכורת ללא זמן. אנא נסה שוב עם זמן מדויק."
        };
      }
      const reminder = this.reminderService!.createReminder(userId, payload.text, payload.datetime, chatId);
      logger.info("reminder created", { userId, reminderId: reminder.id, datetime: reminder.datetime, chatId });
      result = reminder;
    } else if (action.type === PROPOSED_ACTION_TYPES.ADD_TO_LIST) {
      const payload = action.payload as ListRequest;
      const list = payload.targetListId
        ? { id: payload.targetListId }
        : this.listService!.getOrCreateList(userId, payload.listName ?? "קניות");
      const added = this.listService!.addItems(list.id, payload.items);
      logger.info("list items added", { userId, listId: list.id, listName: payload.listName, count: added.length });
      result = { listId: list.id, added: added.length };
    } else if (action.type === PROPOSED_ACTION_TYPES.REMOVE_FROM_LIST) {
      const payload = action.payload as RemoveFromListRequest;
      const list = payload.targetListId
        ? { id: payload.targetListId }
        : this.listService!.getOrCreateList(userId, payload.listName ?? "קניות");
      const removed = this.listService!.removeItemByIndex(list.id, payload.index);
      logger.info("list item removed", { userId, listId: list.id, index: payload.index, removed });
      result = { listId: list.id, removed };
    } else if (action.type === PROPOSED_ACTION_TYPES.SNOOZE_REMINDER) {
      const payload = action.payload as SnoozeReminderRequest;
      let reminderId = payload.reminderId;
      const indexMatch = reminderId.match(/^__index_(\d+)$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10) - 1;
        const reminders = this.reminderService!
          .listReminders(userId)
          .filter((r) => r.status === "pending")
          .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
        if (idx < 0 || idx >= reminders.length) {
          return { status: "rejected", message: "לא מצאתי תזכורת במספר הזה." };
        }
        reminderId = reminders[idx].id;
      }
      const snoozed = this.reminderService!.snoozeReminder(userId, reminderId, payload.newDatetime);
      logger.info("reminder snoozed", { userId, reminderId, newDatetime: payload.newDatetime });
      result = { reminderId, snoozed: Boolean(snoozed) };
    } else if (action.type === PROPOSED_ACTION_TYPES.DELETE_REMINDER) {
      const payload = action.payload as DeleteReminderRequest;
      let reminderId = payload.reminderId;
      // resolve index-based placeholder to actual reminder id
      const indexMatch = reminderId.match(/^__index_(\d+)$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10) - 1;
        const reminders = this.reminderService!
          .listReminders(userId)
          .filter((r) => r.status === "pending")
          .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
        if (idx < 0 || idx >= reminders.length) {
          return { status: "rejected", message: "לא מצאתי תזכורת במספר הזה." };
        }
        reminderId = reminders[idx].id;
      }
      const deleted = this.reminderService!.deleteReminder(userId, reminderId);
      logger.info("reminder deleted", { userId, reminderId, deleted });
      result = { reminderId, deleted };
    } else if (action.type === PROPOSED_ACTION_TYPES.CREATE_LIST) {
      const payload = action.payload as CreateListRequest;
      const list = this.listService!.getOrCreateList(userId, payload.listName);
      logger.info("list created", { userId, listId: list.id, listName: payload.listName });
      result = { listId: list.id, listName: payload.listName };
    } else if (action.type === PROPOSED_ACTION_TYPES.DELETE_LIST) {
      const payload = action.payload as DeleteListRequest;
      const listId = payload.listId ?? this.listService!.findListByName(userId, payload.listName)?.id;
      if (!listId) {
        return { status: "rejected", message: `לא מצאתי רשימה בשם "${payload.listName}".` };
      }
      const deleted = this.listService!.deleteList(userId, listId);
      logger.info("list deleted", { userId, listId, listName: payload.listName, deleted });
      result = { listId, deleted };
    } else if (action.type === PROPOSED_ACTION_TYPES.RUN_APP_ACTION) {
      result = await this.appActions.execute(action.payload as never);
    } else {
      result = action.payload;
    }

    this.memory.removePendingAction(actionId);
    this.memory.clearPendingActionUser(userId);
    this.memory.clearClarification(userId);
    this.memory.addAuditEntry({
      id: createId("audit"),
      type: "confirmation",
      userId,
      payload: {
        actionId,
        actionType: action.type,
        result
      },
      createdAt: new Date().toISOString()
    });

    return {
      status: "completed",
      message: confirmationMessage(action, result),
      result
    };
  }

  private clearPendingConfirmationState(userId: string): void {
    const pendingActionId = this.memory.getPendingActionIdForUser(userId);
    if (!pendingActionId) {
      return;
    }

    this.memory.removePendingAction(pendingActionId);
    this.memory.clearPendingActionUser(userId);
  }

  private syncConversationalState(userId: string, interpretation: AgentInterpretation, createdAt: string): void {
    if (interpretation.intent === AGENT_INTENTS.CLARIFY && interpretation.proposedAction?.missingFields?.length) {
      this.clearPendingConfirmationState(userId);
      this.memory.saveClarification({
        userId,
        action: interpretation.proposedAction,
        missingFields: interpretation.proposedAction.missingFields,
        question: interpretation.draftResponse,
        createdAt
      });
      return;
    }

    this.memory.clearClarification(userId);

    if (interpretation.proposedAction) {
      this.clearPendingConfirmationState(userId);
      this.memory.savePendingAction(interpretation.proposedAction);
      this.memory.setPendingActionUser(userId, interpretation.proposedAction.id);
      return;
    }

    this.clearPendingConfirmationState(userId);
  }

  private resolveListForInterpretation(userId: string, interpretation: AgentInterpretation): AgentInterpretation {
    if (interpretation.intent !== AGENT_INTENTS.ADD_TO_LIST || !this.listService) {
      return interpretation;
    }
    const action = interpretation.proposedAction;
    if (!action) return interpretation;
    const payload = action.payload as ListRequest;

    if (payload.targetListId) return interpretation;

    const userLists = this.listService.listLists(userId);
    const { listName } = payload;

    if (listName) {
      const existing = this.listService.findListByName(userId, listName);
      if (existing) {
        return { ...interpretation, proposedAction: { ...action, payload: { ...payload, targetListId: existing.id } } };
      }
      if (payload.createIfMissing) {
        const newList = this.listService.getOrCreateList(userId, listName);
        return { ...interpretation, proposedAction: { ...action, payload: { ...payload, targetListId: newList.id } } };
      }
      return {
        intent: AGENT_INTENTS.CLARIFY,
        entities: interpretation.entities,
        draftResponse: `לא מצאתי רשימה בשם "${listName}". ליצור אותה? (כן / לא)`,
        proposedAction: { ...action, missingFields: ["createList"] }
      };
    }

    if (userLists.length === 0) {
      const list = this.listService.getOrCreateList(userId, "קניות");
      return { ...interpretation, proposedAction: { ...action, payload: { ...payload, targetListId: list.id } } };
    }

    if (userLists.length === 1) {
      return { ...interpretation, proposedAction: { ...action, payload: { ...payload, targetListId: userLists[0].id } } };
    }

    const topLists = userLists.slice(0, 3);
    const numberedOptions = topLists.map((l, i) => `${i + 1}. ${l.name}`).join("\n");
    return {
      intent: AGENT_INTENTS.CLARIFY,
      entities: interpretation.entities,
      draftResponse: `לאיזו רשימה להוסיף?\n\n${numberedOptions}`,
      proposedAction: { ...action, missingFields: ["listId"] }
    };
  }

  private resumeClarification(
    clarification: ClarificationState,
    replyText: string,
    timezone: string
  ): AgentInterpretation {
    const { action, missingFields } = clarification;

    if (looksLikeCancelReply(replyText)) {
      return {
        intent: AGENT_INTENTS.OUT_OF_SCOPE,
        entities: {},
        draftResponse: "בוטל.",
        proposedAction: undefined
      };
    }

    if (action.type === PROPOSED_ACTION_TYPES.CREATE_LIST) {
      const listName = replyText.trim().replace(/^ה(?=[א-ת])/, "");
      if (!listName) {
        return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: "איך תרצה לקרוא לרשימה?", proposedAction: action };
      }
      const updatedPayload: CreateListRequest = { listName };
      const updatedAction: ProposedAction<CreateListRequest> = { ...action, payload: updatedPayload, missingFields: [] };
      return {
        intent: AGENT_INTENTS.CREATE_LIST,
        entities: { listName },
        draftResponse: `לצור רשימת "${listName}"?`,
        proposedAction: updatedAction
      };
    }

    if (action.type === PROPOSED_ACTION_TYPES.SCHEDULE_MEETING) {
      const existing = action.payload as CalendarRequest;
      const time = parseNaturalLanguageDate(replyText, timezone);
      const updatedPayload: CalendarRequest = {
        ...existing,
        startAt: time.startAt ?? existing.startAt,
        endAt: time.endAt ?? existing.endAt,
        inferredTimeText: time.inferredTimeText ?? existing.inferredTimeText,
        confidence: time.startAt ? time.confidence : existing.confidence
      };
      const remainingMissing = updatedPayload.startAt ? [] : ["startAt"];
      const updatedAction: ProposedAction<CalendarRequest> = { ...action, payload: updatedPayload, missingFields: remainingMissing };

      if (remainingMissing.length > 0) {
        return {
          intent: AGENT_INTENTS.CLARIFY,
          entities: {},
          draftResponse: "עדיין חסרה לי שעת התחלה מדויקת. אפשר לציין שעה?",
          proposedAction: updatedAction
        };
      }
      return {
        intent: AGENT_INTENTS.SCHEDULE_MEETING,
        entities: { title: updatedPayload.title },
        draftResponse: `אקבע את "${updatedPayload.title}" ב-${formatDateTime(updatedPayload.startAt, "he-IL", timezone)}. לאשר?`,
        proposedAction: updatedAction
      };
    }

    if (action.type === PROPOSED_ACTION_TYPES.CREATE_REMINDER) {
      const existing = action.payload as ReminderRequest;

      let updatedText = existing.text;
      let updatedDatetime = existing.datetime;
      let updatedInferredTimeText = existing.inferredTimeText;

      const parsedTime = tryParseReplyAsTime(replyText, timezone);
      if (parsedTime?.startAt) {
        updatedDatetime = parsedTime.startAt;
        updatedInferredTimeText = parsedTime.inferredTimeText ?? existing.inferredTimeText;
        // If the existing text was erroneously filled with a time phrase in a prior turn, clear it
        if (updatedText && tryParseReplyAsTime(updatedText, timezone)) {
          updatedText = "";
        }
      } else if (!updatedText || missingFields.includes("text")) {
        // Only overwrite text when we are actually collecting it — not when the bot
        // asked for a time and the reply happened to fail time-parsing.
        updatedText = replyText.trim();
      }

      const remainingMissing: string[] = [];
      if (!updatedText) remainingMissing.push("text");
      if (!updatedDatetime) remainingMissing.push("startAt");

      const updatedPayload: ReminderRequest = { text: updatedText, datetime: updatedDatetime, inferredTimeText: updatedInferredTimeText };
      const updatedAction: ProposedAction<ReminderRequest> = { ...action, payload: updatedPayload, missingFields: remainingMissing };

      if (remainingMissing.length > 0) {
        const question = !updatedText ? "על מה תרצה שאזכיר לך?" : "מתי תרצה שאזכיר לך?";
        return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: question, proposedAction: updatedAction };
      }
      return {
        intent: AGENT_INTENTS.CREATE_REMINDER,
        entities: { text: updatedText },
        draftResponse: `אזכיר לך "${updatedText}" ב-${formatDateTime(updatedDatetime, "he-IL", timezone)}. לאשר?`,
        proposedAction: updatedAction
      };
    }

    if (action.type === PROPOSED_ACTION_TYPES.ADD_TO_LIST) {
      if (looksLikeListCommand(replyText)) {
        return {
          intent: AGENT_INTENTS.OUT_OF_SCOPE,
          entities: {},
          draftResponse: "לא הבנתי את הבקשה. אפשר לרשום את הפריטים שתרצה להוסיף?",
          proposedAction: undefined
        };
      }
      const existing = action.payload as ListRequest;

      if (missingFields.includes("createList")) {
        if (/^(?:כן|yes|אוקי|בסדר|יצור|צור)/i.test(replyText.trim())) {
          const updatedPayload: ListRequest = { ...existing, createIfMissing: true };
          const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: existing.items.length > 0 ? [] : ["items"] };
          const listDisplayName = existing.listName ?? "קניות";
          return {
            intent: existing.items.length > 0 ? AGENT_INTENTS.ADD_TO_LIST : AGENT_INTENTS.CLARIFY,
            entities: { items: existing.items },
            draftResponse: existing.items.length > 0
              ? `להוסיף לרשימת ${listDisplayName}: ${existing.items.join(", ")}?`
              : `אוצור את רשימת "${listDisplayName}". מה לרשום בה?`,
            proposedAction: updatedAction
          };
        }
        const redirectName = extractListRedirect(replyText);
        if (redirectName) {
          const updatedPayload: ListRequest = { ...existing, listName: redirectName };
          const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: existing.items.length > 0 ? [] : ["items"] };
          if (existing.items.length > 0) {
            return {
              intent: AGENT_INTENTS.ADD_TO_LIST,
              entities: { items: existing.items },
              draftResponse: `להוסיף לרשימת ${redirectName}: ${existing.items.join(", ")}?`,
              proposedAction: updatedAction
            };
          }
          return {
            intent: AGENT_INTENTS.CLARIFY,
            entities: {},
            draftResponse: `מה לרשום ברשימת ${redirectName}?`,
            proposedAction: updatedAction
          };
        }
        // Explicit "no" → cancel cleanly
        if (/^(?:לא|no)(?:\s|$)/i.test(replyText.trim())) {
          return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: "בסדר, לא יצרתי רשימה חדשה.", proposedAction: undefined };
        }
        // Unrecognised reply — re-ask rather than cancel prematurely
        return {
          intent: AGENT_INTENTS.CLARIFY,
          entities: {},
          draftResponse: `לא הבנתי. ליצור את רשימת "${existing.listName ?? ""}"? (כן / לא)`,
          proposedAction: { ...action, missingFields: ["createList"] }
        };
      }

      if (missingFields.includes("listId")) {
        // Redirect embedded in a negative: "לא, לרשימת קניות" / "לא לרשימת משימות"
        const redirectName = extractListRedirect(replyText);
        if (redirectName) {
          const updatedPayload: ListRequest = { ...existing, listName: redirectName };
          const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: existing.items.length > 0 ? [] : ["items"] };
          if (existing.items.length > 0) {
            return {
              intent: AGENT_INTENTS.ADD_TO_LIST,
              entities: { items: existing.items },
              draftResponse: `להוסיף לרשימת ${redirectName}: ${existing.items.join(", ")}?`,
              proposedAction: updatedAction
            };
          }
          return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: `מה לרשום ברשימת ${redirectName}?`, proposedAction: updatedAction };
        }
        // Plain cancel
        if (/^(?:לא|no)(?:\s|$)/i.test(replyText.trim())) {
          return { intent: AGENT_INTENTS.OUT_OF_SCOPE, entities: {}, draftResponse: "בוטל.", proposedAction: undefined };
        }
        // User restated the add command — update items and re-ask for list
        if (/^(?:תוסיף|תוסיפי)\b/i.test(replyText.trim())) {
          const newItems = replyText.trim()
            .replace(/^(?:תוסיף|תוסיפי)\s+/i, "")
            .replace(/\s+(?:לרשימת|ברשימת)\s+ה?[\u0590-\u05FF]+/iu, "")
            .split(/[\n,،]+/)
            .map((i) => i.replace(/^ו+/, "").trim())
            .filter((i) => i.length > 0);
          const updatedItems = newItems.length > 0 ? newItems : existing.items;
          const userLists = this.listService?.listLists(clarification.userId).slice(0, 3) ?? [];
          const numberedOptions = userLists.map((l, idx) => `${idx + 1}. ${l.name}`).join("\n");
          const updatedPayload: ListRequest = { ...existing, items: updatedItems };
          const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: ["listId"] };
          return {
            intent: AGENT_INTENTS.CLARIFY,
            entities: { items: updatedItems },
            draftResponse: `לאיזו רשימה להוסיף?\n\n${numberedOptions}`,
            proposedAction: updatedAction
          };
        }
        const userLists = this.listService?.listLists(clarification.userId).slice(0, 3) ?? [];
        const resolvedListName = resolveListReply(replyText, userLists);
        const updatedPayload: ListRequest = { ...existing, listName: resolvedListName };
        const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: existing.items.length > 0 ? [] : ["items"] };
        if (existing.items.length > 0) {
          return {
            intent: AGENT_INTENTS.ADD_TO_LIST,
            entities: { items: existing.items },
            draftResponse: `להוסיף לרשימת ${resolvedListName}: ${existing.items.join(", ")}?`,
            proposedAction: updatedAction
          };
        }
        return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: `מה לרשום ברשימת ${resolvedListName}?`, proposedAction: updatedAction };
      }

      // items branch: strip add-command prefixes per-item so "תוסיף חלב" / "גם חלב" don't create polluted items
      const newItems = replyText
        .split(/[\n,،]+/)
        .map((i) =>
          i
            .replace(/^(?:תוסיף לי|תוסיף|תוסיפי)\s+(?:[לב]רשימת\s+ה?[\u0590-\u05FF]+|רשימת\s+ה?[\u0590-\u05FF]+|ל[\u0590-\u05FF]+)\s*/iu, "")
            .replace(/^(?:תוסיף לי|תוסיף|תוסיפי)\s+/iu, "")
            .replace(/^גם\s+/iu, "")
            .trim()
        )
        .filter((i) => i.length > 0);
      const items = existing.items.length > 0 ? existing.items : newItems;
      const listDisplayName = existing.listName ?? "קניות";
      const updatedPayload: ListRequest = { ...existing, items };
      const updatedAction: ProposedAction<ListRequest> = { ...action, payload: updatedPayload, missingFields: [] };

      if (items.length === 0) {
        return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: `מה לרשום ברשימת ${listDisplayName}?`, proposedAction: { ...updatedAction, missingFields: ["items"] } };
      }
      return {
        intent: AGENT_INTENTS.ADD_TO_LIST,
        entities: { items },
        draftResponse: `להוסיף לרשימת ${listDisplayName}: ${items.join(", ")}?`,
        proposedAction: updatedAction
      };
    }

    if (action.type === PROPOSED_ACTION_TYPES.DELETE_REMINDER) {
      if (missingFields.includes("reminderIndex")) {
        const indexMatch = replyText.trim().match(/^(\d+)$/);
        if (!indexMatch) {
          return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: "ציין מספר תזכורת (לדוגמה: 1).", proposedAction: action };
        }
        const index = parseInt(indexMatch[1], 10);
        const updatedPayload: DeleteReminderRequest = { ...(action.payload as DeleteReminderRequest), reminderId: `__index_${index}` };
        const updatedAction: ProposedAction<DeleteReminderRequest> = { ...action, payload: updatedPayload, missingFields: [] };
        return {
          intent: AGENT_INTENTS.DELETE_REMINDER,
          entities: { index },
          draftResponse: `למחוק תזכורת מספר ${index}?`,
          proposedAction: updatedAction
        };
      }
    }

    if (action.type === PROPOSED_ACTION_TYPES.SNOOZE_REMINDER) {
      const existing = action.payload as SnoozeReminderRequest;

      if (missingFields.includes("reminderIndex")) {
        const indexMatch = replyText.trim().match(/^(\d+)$/);
        if (!indexMatch) {
          return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: "ציין מספר תזכורת (לדוגמה: 1).", proposedAction: action };
        }
        const index = parseInt(indexMatch[1], 10);
        const updatedPayload: SnoozeReminderRequest = { ...existing, reminderId: `__index_${index}` };
        const updatedAction: ProposedAction<SnoozeReminderRequest> = { ...action, payload: updatedPayload, missingFields: ["snoozeTime"] };
        return {
          intent: AGENT_INTENTS.CLARIFY,
          entities: { index },
          draftResponse: `לאיזה זמן לדחות תזכורת ${index}?`,
          proposedAction: updatedAction
        };
      }

      if (missingFields.includes("snoozeTime")) {
        const parsedTime = tryParseReplyAsTime(replyText, timezone);
        if (!parsedTime?.startAt) {
          return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: "לאיזה זמן לדחות? (לדוגמה: \"מחר בשעה 9\", \"בבוקר\")", proposedAction: action };
        }
        const updatedPayload: SnoozeReminderRequest = { ...existing, newDatetime: parsedTime.startAt };
        const updatedAction: ProposedAction<SnoozeReminderRequest> = { ...action, payload: updatedPayload, missingFields: [] };
        const indexLabel = existing.reminderId.match(/^__index_(\d+)$/)?.[1] ?? "";
        return {
          intent: AGENT_INTENTS.SNOOZE_REMINDER,
          entities: {},
          draftResponse: `לדחות תזכורת ${indexLabel} ל-${formatDateTime(updatedPayload.newDatetime, "he-IL", timezone)}?`,
          proposedAction: updatedAction
        };
      }
    }

    if (action.type === PROPOSED_ACTION_TYPES.DELETE_LIST) {
      const listName = replyText.trim().replace(/^ה(?=[א-ת])/, "");
      if (!listName) {
        return { intent: AGENT_INTENTS.CLARIFY, entities: {}, draftResponse: "איזו רשימה למחוק?", proposedAction: action };
      }
      const updatedPayload: DeleteListRequest = { listName };
      const updatedAction: ProposedAction<DeleteListRequest> = { ...action, payload: updatedPayload, missingFields: [] };
      return {
        intent: AGENT_INTENTS.DELETE_LIST,
        entities: { listName },
        draftResponse: `למחוק את רשימת ${listName}?`,
        proposedAction: updatedAction
      };
    }

    return {
      intent: AGENT_INTENTS.OUT_OF_SCOPE,
      entities: {},
      draftResponse: "לא הצלחתי להמשיך את הבקשה. אפשר לנסות מחדש?",
      proposedAction: undefined
    };
  }
}

// module-level helpers

/**
 * Returns true when the normalised input clearly belongs to a new intent domain,
 * so an active clarification flow should be abandoned rather than resumed.
 */
function looksLikeNewIntent(normalized: string): boolean {
  return (
    matchesAny(normalized, MEETING_TRIGGERS) ||
    matchesAny(normalized, CALENDAR_VIEW_TRIGGERS) ||
    matchesAny(normalized, REMINDER_TRIGGERS) ||
    matchesAny(normalized, REMINDER_VIEW_TRIGGERS) ||
    matchesAny(normalized, REMINDER_DELETE_TRIGGERS) ||
    matchesAny(normalized, REMINDER_SNOOZE_TRIGGERS) ||
    matchesAny(normalized, CREATE_LIST_TRIGGERS) ||
    matchesAny(normalized, DELETE_LIST_TRIGGERS) ||
    matchesAny(normalized, DELETE_LIST_BARE_TRIGGERS) ||
    matchesAny(normalized, LIST_ADD_TRIGGERS) ||
    matchesAny(normalized, LIST_VIEW_TRIGGERS) ||
    matchesAny(normalized, LIST_VIEW_ALL_TRIGGERS) ||
    matchesAny(normalized, LIST_REMOVE_TRIGGERS)
  );
}

function looksLikeCancelReply(text: string): boolean {
  return /^(?:לא משנה|עזוב|בטל|ביטול|cancel|never mind|skip)(?:\s|$)/i.test(text.trim());
}

function looksLikeTextConfirm(text: string): boolean {
  return /^(?:כן|yes|אוקי|בסדר|אישור|אשר)(?:\s|$)/i.test(text.trim());
}

function looksLikeTextCancel(text: string): boolean {
  return /^(?:לא|no|בטל|ביטול|cancel|עזוב|לא משנה|never mind)(?:\s|$)/i.test(text.trim());
}

function isValidListItem(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > 80) return false;
  if (trimmed.includes("?")) return false;
  const hebrewQuestionWords = /(?:^|\s)(?:מה|למה|איך|מתי|איפה)(?:\s|$)/;
  if (hebrewQuestionWords.test(trimmed)) return false;
  return true;
}

/**
 * Resolves a free-text list-selection reply to a canonical list name.
 * Accepts: numeric index ("1"), bare name ("קניות"), prepositional form ("לקניות"),
 * or prefixed form ("רשימת קניות", "לרשימת קניות").
 */
function resolveListReply(replyText: string, suggestions: { name: string }[]): string {
  const trimmed = replyText.trim();

  // Numeric index: "1", "2", "3"
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < suggestions.length) {
      return suggestions[idx].name;
    }
  }

  // Ordinal phrases: "הראשונה" / "הראשון" → 0, "השנייה" → 1, "השלישית" → 2
  const ORDINAL_MAP: Record<string, number> = {
    "ראשון": 0, "ראשונה": 0, "הראשון": 0, "הראשונה": 0,
    "שני": 1, "שנייה": 1, "שניה": 1, "השני": 1, "השנייה": 1, "השניה": 1,
    "שלישי": 2, "שלישית": 2, "השלישי": 2, "השלישית": 2
  };
  if (trimmed in ORDINAL_MAP) {
    const idx = ORDINAL_MAP[trimmed];
    if (idx < suggestions.length) {
      return suggestions[idx].name;
    }
  }

  // Strip prepositional / article prefixes to get the bare name
  const bare = trimmed
    .replace(/^(?:לרשימת|ברשימת|רשימת)\s+ה?/i, "")
    .replace(/^ל(?=[\u0590-\u05FF])/u, "")
    .trim();

  // Case-insensitive match against the suggestion names
  const normalised = bare.replace(/\s+/g, " ").toLowerCase();
  const found = suggestions.find(
    (l) => l.name.replace(/\s+/g, " ").toLowerCase() === normalised
  );
  if (found) return found.name;

  // Fall back: treat as a new/unknown list name (resolveListForInterpretation will handle)
  return bare || trimmed;
}

/**
 * Detects a redirect embedded in a negative reply, e.g.:
 * "לא, לקניות" / "לא, לרשימת קניות" / "לא, תוסיף לרשימת קניות"
 * Returns the target list name, or undefined if none found.
 */
function extractListRedirect(text: string): string | undefined {
  const trimmed = text.trim();
  if (!/^(?:לא|no)\b/i.test(trimmed)) return undefined;

  const rest = trimmed.replace(/^(?:לא|no)[,،.;\s]+/i, "").trim();
  if (!rest) return undefined;

  // Strip optional action prefix "תוסיף (את זה)?"
  const afterAction = rest.replace(/^תוסיף\s+(?:את\s+זה\s+)?/i, "").trim();

  const nameMatch = afterAction.match(
    /^(?:לרשימת\s+ה?|ברשימת\s+ה?|לרשימה\s+ה?|ל(?=[\u0590-\u05FF]))([\u0590-\u05FF]+(?:\s+[\u0590-\u05FF]+)*)/u
  );
  return nameMatch?.[1]?.trim();
}

function looksLikeListCommand(text: string): boolean {
  return /^(?:להציג|הצג|תציג|לראות|ראה|תראה|מה יש|הראה)/i.test(text.trim());
}

function normalizeTimeReply(text: string): string {
  // "עוד X" is a common alternative to "בעוד X" — normalise before parsing
  return text.trim().replace(/^עוד\s+/i, "בעוד ");
}

function tryParseReplyAsTime(text: string, timezone: string): ParsedTimeResult | undefined {
  const normalized = normalizeTimeReply(text);

  // Bare HH:MM (e.g. "15:00", "9:30") — prepend "ב" so the Hebrew time parser
  // matches its HEBREW_AT_PATTERN prefix and resolves to today/tomorrow at that hour.
  if (/^\d{1,2}:\d{2}$/.test(normalized)) {
    const withPrefix = parseNaturalLanguageDate(`ב${normalized}`, timezone);
    if (withPrefix.startAt) return withPrefix;
  }

  const direct = parseNaturalLanguageDate(normalized, timezone);
  if (direct.startAt) return direct;

  const withHebrew = parseNaturalLanguageDate(`בעוד ${normalized}`, timezone);
  if (withHebrew.startAt) return withHebrew;

  const withEnglish = parseNaturalLanguageDate(`in ${normalized}`, timezone);
  if (withEnglish.startAt) return withEnglish;

  return undefined;
}

function confirmationMessage(action: ProposedAction, result: unknown): string {
  if (action.type === PROPOSED_ACTION_TYPES.SCHEDULE_MEETING && isSkippedResult(result)) {
    return "כדי ליצור את האירוע בפועל צריך קודם לחבר את Google Calendar.";
  }

  switch (action.type) {
    case PROPOSED_ACTION_TYPES.SCHEDULE_MEETING:
      return "האירוע אושר ונשלח ליצירה ביומן.";
    case PROPOSED_ACTION_TYPES.CREATE_LIST:
      return `נוצרה רשימת ${(action.payload as CreateListRequest).listName}.`;
    case PROPOSED_ACTION_TYPES.ADD_TO_LIST: {
      const listName = (action.payload as ListRequest).listName ?? "קניות";
      return `הפריטים נוספו לרשימת ${listName}.`;
    }
    case PROPOSED_ACTION_TYPES.REMOVE_FROM_LIST: {
      const listName = (action.payload as RemoveFromListRequest).listName ?? "קניות";
      return `הפריט הוסר מרשימת ${listName}.`;
    }
    case PROPOSED_ACTION_TYPES.DELETE_LIST: {
      const listName = (action.payload as DeleteListRequest).listName;
      return `רשימת ${listName} נמחקה.`;
    }
    case PROPOSED_ACTION_TYPES.CREATE_REMINDER:
      return "התזכורת נשמרה. אשלח לך הודעה בזמן שנקבע.";
    case PROPOSED_ACTION_TYPES.SNOOZE_REMINDER:
      return "התזכורת נדחתה לזמן החדש.";
    case PROPOSED_ACTION_TYPES.DELETE_REMINDER:
      return "התזכורת נמחקה.";
    case PROPOSED_ACTION_TYPES.RUN_APP_ACTION:
      return "הפעולה באפליקציה אושרה ובוצעה.";
    default:
      return "הטיוטה נשמרה ומוכנה לשימוש.";
  }
}

/**
 * Extracts a list name from a view-list phrase for the deterministic intercept.
 * Handles "תציג לי את רשימת X", "תציג לי את X", "מה יש ברשימת X", etc.
 * Returns undefined for generic "הרשימה" (falls back to first list).
 */
function inferViewListName(text: string): string | undefined {
  // "רשימת X" — with optional ה prefix on name
  const constructMatch = text.match(/(?:לרשימת|ברשימת|רשימת)\s+ה?([\u0590-\u05FF]+)/iu);
  if (constructMatch?.[1]) return constructMatch[1].trim();
  // "view-verb [לי] את [ה]<name>" — bare name (skip generic "רשימה/רשימות")
  const viewBareMatch = text.match(/(?:תציג|תציגי|הצג|הציגי|תראה|תראי|הראה|הראי|תפתח|תפתחי|פתח|פתחי)\s+(?:לי\s+)?את\s+ה?([\u0590-\u05FF]+)/iu);
  if (viewBareMatch?.[1]) {
    const name = viewBareMatch[1].trim();
    if (/^רשימ(?:ה|ות)$/.test(name)) return undefined;
    return name;
  }
  return undefined;
}

/**
 * Detects numeric or ordinal list references in user input.
 * Returns the 0-based index if matched, or undefined if the input is not a list reference.
 *
 * Supported patterns:
 * - Bare number: "1", "2"
 * - "תציג/תפתח/הצג ... את N" / "את רשימה מספר N" / "את רשימה N"
 * - Hebrew ordinals: הראשונה, השנייה, השלישית, etc.
 */
function tryResolveNumberedListReference(text: string): number | undefined {
  const trimmed = text.trim();

  // Hebrew ordinal map (0-based)
  const ORDINALS: Record<string, number> = {
    "ראשון": 0, "ראשונה": 0, "הראשון": 0, "הראשונה": 0,
    "שני": 1, "שנייה": 1, "שניה": 1, "השני": 1, "השנייה": 1, "השניה": 1,
    "שלישי": 2, "שלישית": 2, "השלישי": 2, "השלישית": 2,
    "רביעי": 3, "רביעית": 3, "הרביעי": 3, "הרביעית": 3,
    "חמישי": 4, "חמישית": 4, "החמישי": 4, "החמישית": 4
  };

  // Bare number: "1", "2", etc.
  const bareNum = trimmed.match(/^(\d+)$/);
  if (bareNum) {
    return parseInt(bareNum[1], 10) - 1;
  }

  // "תציג/תפתח/הצג/הראה ... את רשימה מספר N" or "את רשימה N" or "את N" or ordinal
  const viewPrefix = /^(?:תציג|תציגי|הצג|הציגי|תפתח|תפתחי|פתח|פתחי|תראה|תראי|הראה|הראי)\s+(?:לי\s+)?את\s+/;
  const afterPrefix = trimmed.replace(viewPrefix, "");
  if (afterPrefix !== trimmed) {
    // "רשימה מספר N" or "רשימה N"
    const listNumMatch = afterPrefix.match(/^רשימה\s+(?:מספר\s+)?(\d+)$/);
    if (listNumMatch) {
      return parseInt(listNumMatch[1], 10) - 1;
    }
    // Bare number after prefix: "את 1"
    const numMatch = afterPrefix.match(/^(\d+)$/);
    if (numMatch) {
      return parseInt(numMatch[1], 10) - 1;
    }
    // Ordinal after prefix: "את הראשונה"
    const ordinalTrimmed = afterPrefix.trim();
    if (ordinalTrimmed in ORDINALS) {
      return ORDINALS[ordinalTrimmed];
    }
  }

  // Standalone ordinal (no prefix): "הראשונה", "השנייה"
  if (trimmed in ORDINALS) {
    return ORDINALS[trimmed];
  }

  return undefined;
}

/**
 * Returns true when the input is an unambiguous list-view reference —
 * i.e. it has a Hebrew view-command prefix like "תציג לי את".
 * Bare numbers ("1") and standalone ordinals ("הראשונה") are ambiguous
 * without context and should NOT trigger the no-context error.
 */
function isExplicitListViewReference(text: string): boolean {
  const viewPrefix = /^(?:תציג|תציגי|הצג|הציגי|תפתח|תפתחי|פתח|פתחי|תראה|תראי|הראה|הראי)\s+(?:לי\s+)?את\s+/;
  return viewPrefix.test(text.trim());
}

function isSkippedResult(result: unknown): result is { status: string } {
  return typeof result === "object" && result !== null && "status" in result && (result as { status: string }).status === "skipped";
}

function reminderDayLabel(isoDate: string, timezone: string): string | undefined {
  const now = new Date();
  const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const reminderDay = fmt(new Date(isoDate));
  const today = fmt(now);
  const tomorrow = fmt(new Date(now.getTime() + 86_400_000));
  if (reminderDay === today) return "היום";
  if (reminderDay === tomorrow) return "מחר";
  return undefined;
}
