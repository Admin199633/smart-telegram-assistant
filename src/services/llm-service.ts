import {
  AgentInterpretation,
  AppActionRequest,
  CalendarRequest,
  ComposeDraftPayload,
  ComposeVariant,
  ConversationTurn,
  CreateListRequest,
  DeleteListRequest,
  DeleteReminderRequest,
  ListRequest,
  ProposedAction,
  RemoveFromListRequest,
  ReminderRequest,
  SnoozeReminderRequest,
  Tone,
  UserProfile
} from "../types.js";
import { config } from "../config.js";
import { AGENT_INTENT_VALUES, AGENT_INTENTS, PROPOSED_ACTION_TYPES, type AgentIntent } from "../supported-actions.js";
import { createId } from "../utils/id.js";
import { formatDateTime, parseNaturalLanguageDate } from "../utils/time.js";
import { createSmartChatCompletion } from "./smart-chat.js";
import {
  normalizeInput,
  matchesAny,
  REMINDER_TRIGGERS,
  REMINDER_VIEW_TRIGGERS,
  REMINDER_DELETE_TRIGGERS,
  REMINDER_SNOOZE_TRIGGERS,
  MEETING_TRIGGERS,
  CALENDAR_VIEW_TRIGGERS,
  CALENDAR_UPDATE_TRIGGERS,
  CALENDAR_DELETE_TRIGGERS,
  COMPOSE_TRIGGERS,
  LIST_ADD_TRIGGERS,
  LIST_VIEW_TRIGGERS,
  LIST_VIEW_ALL_TRIGGERS,
  LIST_REMOVE_TRIGGERS,
  APP_ACTION_TRIGGERS,
  CREATE_LIST_TRIGGERS,
  DELETE_LIST_TRIGGERS,
  DELETE_LIST_BARE_TRIGGERS
} from "../utils/normalize.js";
import { logger } from "../utils/logger.js";

interface InterpretArgs {
  userId: string;
  text: string;
  profile: UserProfile;
  conversation?: ConversationTurn[];
}

export class LlmService {
  async interpret({ userId, text, profile }: InterpretArgs): Promise<AgentInterpretation> {
    const normalized = normalizeInput(text);

    // AI-first: try structured AI for ALL messages before heuristics
    if (config.openAiApiKey) {
      const aiResult = await this.tryOpenAiInterpretation({ userId, text, profile });
      if (aiResult) {
        logger.info("routing decided by AI", { userId });
        return aiResult;
      }
      logger.info("AI unavailable, falling back to heuristics", { userId });
    }

    // Fallback: compose-specific path
    if (looksLikeComposeRequest(normalized) && !looksLikeReminderRequest(normalized) && !looksLikeListRequest(normalized) && !looksLikeCreateListRequest(normalized)) {
      return this.heuristicWithSmartFallback(normalized, text, profile);
    }

    // Fallback: general heuristics
    return this.heuristicWithSmartFallback(normalized, text, profile);
  }

  private async heuristicWithSmartFallback(normalized: string, originalText: string, profile: UserProfile): Promise<AgentInterpretation> {
    const result = this.heuristicInterpretation(normalized, profile);
    if (result.intent === AGENT_INTENTS.OUT_OF_SCOPE) {
      try {
        const reply = await createSmartChatCompletion(originalText);
        if (reply) {
          return {
            intent: AGENT_INTENTS.OUT_OF_SCOPE,
            entities: {},
            draftResponse: reply,
            proposedAction: undefined
          };
        }
      } catch {
        // fall through to heuristic result
      }
    }
    return result;
  }

  private heuristicInterpretation(text: string, profile: UserProfile): AgentInterpretation {
    const normalized = normalizeInput(text);

    if (looksLikeComposeRequest(normalized) && !looksLikeReminderRequest(normalized) && !looksLikeListRequest(normalized) && !looksLikeCreateListRequest(normalized)) {
      const tone = inferTone(normalized, profile);
      const variants = buildDraftVariants(normalized, tone);
      const draftedMessage = formatComposeResponse(variants);
      const action: ProposedAction<ComposeDraftPayload> = {
        id: createId("compose"),
        type: PROPOSED_ACTION_TYPES.COMPOSE_MESSAGE,
        summary: "טיוטת הודעה מוכנה לשליחה",
        requiresConfirmation: true,
        payload: {
          tone,
          content: variants[0]?.content ?? "",
          variants
        }
      };

      return {
        intent: AGENT_INTENTS.COMPOSE_MESSAGE,
        entities: {
          tone
        },
        draftResponse: draftedMessage,
        proposedAction: action
      };
    }

    if (looksLikeCalendarViewRequest(normalized)) {
      return {
        intent: AGENT_INTENTS.OUT_OF_SCOPE,
        entities: {},
        draftResponse: "אני עדיין לא תומך בצפייה ביומן. אוכל לעזור ביצירת פגישות.",
        proposedAction: undefined
      };
    }

    if (looksLikeCalendarUpdateRequest(normalized)) {
      return {
        intent: AGENT_INTENTS.OUT_OF_SCOPE,
        entities: {},
        draftResponse: "עדכון פגישות עדיין לא זמין. אוכל לעזור ביצירת פגישה חדשה.",
        proposedAction: undefined
      };
    }

    if (looksLikeCalendarDeleteRequest(normalized)) {
      return {
        intent: AGENT_INTENTS.OUT_OF_SCOPE,
        entities: {},
        draftResponse: "ביטול פגישות עדיין לא זמין.",
        proposedAction: undefined
      };
    }

    if (looksLikeMeetingRequest(normalized)) {
      const time = parseNaturalLanguageDate(normalized, profile.schedulingPreferences.timezone);
      const title = inferMeetingTitle(normalized);
      const participants = inferParticipants(normalized);
      const payload: CalendarRequest = {
        title,
        participants,
        startAt: time.startAt,
        endAt: time.endAt,
        inferredTimeText: time.inferredTimeText,
        confidence: time.confidence
      };
      const action: ProposedAction<CalendarRequest> = {
        id: createId("meeting"),
        type: PROPOSED_ACTION_TYPES.SCHEDULE_MEETING,
        summary: `לקבוע פגישה "${title}" ל-${formatDateTime(time.startAt, "he-IL", profile.schedulingPreferences.timezone)}`,
        requiresConfirmation: true,
        payload,
        missingFields: time.missingFields
      };
      return {
        intent: time.missingFields.length > 0 ? AGENT_INTENTS.CLARIFY : AGENT_INTENTS.SCHEDULE_MEETING,
        entities: {
          title,
          participants
        },
        draftResponse: time.missingFields.length > 0
          ? "הבנתי שמדובר בפגישה, אבל חסרה לי שעת התחלה מדויקת. אפשר לחדד מתי לקבוע?"
          : `הבנתי שצריך לקבוע את "${title}" ב-${formatDateTime(time.startAt, "he-IL", profile.schedulingPreferences.timezone)}. לאשר יצירת אירוע?`,
        proposedAction: action
      };
    }

    if (looksLikeSnoozeReminderRequest(normalized)) {
      const indexMatch = normalized.match(/(?:תזכורת\s+)?(?:מספר\s+)?(\d+)/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : null;
      const time = parseNaturalLanguageDate(normalized, profile.schedulingPreferences.timezone);
      if (index !== null && time.startAt) {
        const payload: SnoozeReminderRequest = { reminderId: `__index_${index}`, reminderText: "", newDatetime: time.startAt };
        const action: ProposedAction<SnoozeReminderRequest> = {
          id: createId("snooze_reminder"),
          type: PROPOSED_ACTION_TYPES.SNOOZE_REMINDER,
          summary: `דחיית תזכורת ${index}`,
          requiresConfirmation: true,
          payload
        };
        return {
          intent: AGENT_INTENTS.SNOOZE_REMINDER,
          entities: { index, newDatetime: time.startAt },
          draftResponse: `לדחות תזכורת מספר ${index} ל-${formatDateTime(time.startAt, "he-IL", profile.schedulingPreferences.timezone)}?`,
          proposedAction: action
        };
      }
      const snoozeAction: ProposedAction<SnoozeReminderRequest> = {
        id: createId("snooze_reminder"),
        type: PROPOSED_ACTION_TYPES.SNOOZE_REMINDER,
        summary: "דחיית תזכורת",
        requiresConfirmation: true,
        payload: { reminderId: "", reminderText: "", newDatetime: "" },
        missingFields: ["reminderIndex"]
      };
      return {
        intent: AGENT_INTENTS.CLARIFY,
        entities: {},
        draftResponse: "איזו תזכורת לדחות? ציין מספר.",
        proposedAction: snoozeAction
      };
    }

    if (looksLikeDeleteReminderRequest(normalized)) {
      const indexMatch = normalized.match(/(?:מספר\s+)?(\d+)/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : null;
      if (index !== null) {
        // placeholder payload — orchestrator resolves the actual reminder by index at confirm time
        const payload: DeleteReminderRequest = { reminderId: `__index_${index}`, reminderText: "" };
        const action: ProposedAction<DeleteReminderRequest> = {
          id: createId("del_reminder"),
          type: PROPOSED_ACTION_TYPES.DELETE_REMINDER,
          summary: `מחיקת תזכורת מספר ${index}`,
          requiresConfirmation: true,
          payload
        };
        return {
          intent: AGENT_INTENTS.DELETE_REMINDER,
          entities: { index },
          draftResponse: `למחוק תזכורת מספר ${index}?`,
          proposedAction: action
        };
      }
      const deleteAction: ProposedAction<DeleteReminderRequest> = {
        id: createId("del_reminder"),
        type: PROPOSED_ACTION_TYPES.DELETE_REMINDER,
        summary: "מחיקת תזכורת",
        requiresConfirmation: true,
        payload: { reminderId: "", reminderText: "" },
        missingFields: ["reminderIndex"]
      };
      return {
        intent: AGENT_INTENTS.CLARIFY,
        entities: {},
        draftResponse: "איזו תזכורת למחוק? ציין מספר מהרשימה.",
        proposedAction: deleteAction
      };
    }

    if (looksLikeViewRemindersRequest(normalized)) {
      return {
        intent: AGENT_INTENTS.VIEW_REMINDERS,
        entities: {},
        draftResponse: "אין לך תזכורות פעילות כרגע.",
        proposedAction: undefined
      };
    }

    if (looksLikeReminderRequest(normalized)) {
      const time = parseNaturalLanguageDate(normalized, profile.schedulingPreferences.timezone);
      const reminderText = inferReminderText(normalized);
      const missingFields: string[] = [];
      if (time.missingFields.length > 0) missingFields.push(...time.missingFields);
      if (!reminderText) missingFields.push("text");
      const payload: ReminderRequest = {
        text: reminderText,
        datetime: time.startAt,
        inferredTimeText: time.inferredTimeText
      };
      const action: ProposedAction<ReminderRequest> = {
        id: createId("reminder"),
        type: PROPOSED_ACTION_TYPES.CREATE_REMINDER,
        summary: `תזכורת: "${reminderText}"`,
        requiresConfirmation: true,
        payload,
        missingFields
      };
      const hasMissing = missingFields.length > 0;
      const clarifyQuestion = !reminderText ? "על מה תרצה שאזכיר לך?" : "מתי תרצה שאזכיר לך?";
      return {
        intent: hasMissing ? AGENT_INTENTS.CLARIFY : AGENT_INTENTS.CREATE_REMINDER,
        entities: { text: reminderText, datetime: time.startAt },
        draftResponse: hasMissing
          ? clarifyQuestion
          : `אזכיר לך "${reminderText}" ב-${formatDateTime(time.startAt, "he-IL", profile.schedulingPreferences.timezone)}. לאשר?`,
        proposedAction: action
      };
    }

    if (looksLikeCreateListRequest(normalized)) {
      const listName = inferNewListName(normalized);
      if (listName) {
        const payload: CreateListRequest = { listName };
        const action: ProposedAction<CreateListRequest> = {
          id: createId("list_create"),
          type: PROPOSED_ACTION_TYPES.CREATE_LIST,
          summary: `יצירת רשימת ${listName}`,
          requiresConfirmation: true,
          payload,
          missingFields: []
        };
        return {
          intent: AGENT_INTENTS.CREATE_LIST,
          entities: { listName },
          draftResponse: `לצור רשימת "${listName}"?`,
          proposedAction: action
        };
      }
      // Name not provided — ask for it
      const action: ProposedAction<CreateListRequest> = {
        id: createId("list_create"),
        type: PROPOSED_ACTION_TYPES.CREATE_LIST,
        summary: "יצירת רשימה חדשה",
        requiresConfirmation: true,
        payload: { listName: "" },
        missingFields: ["listName"]
      };
      return {
        intent: AGENT_INTENTS.CLARIFY,
        entities: {},
        draftResponse: "איך תרצה לקרוא לרשימה?",
        proposedAction: action
      };
    }

    if (looksLikeRemoveFromListRequest(normalized)) {
      const index = inferRemoveIndex(normalized);
      if (index > 0) {
        const listName = inferListName(normalized);
        const listDisplayName = listName ?? "קניות";
        const payload: RemoveFromListRequest = { index, listName };
        const action: ProposedAction<RemoveFromListRequest> = {
          id: createId("list_remove"),
          type: PROPOSED_ACTION_TYPES.REMOVE_FROM_LIST,
          summary: `הסרת פריט ${index} מרשימת ${listDisplayName}`,
          requiresConfirmation: true,
          payload
        };
        return {
          intent: AGENT_INTENTS.REMOVE_FROM_LIST,
          entities: { index },
          draftResponse: `להסיר פריט מספר ${index} מרשימת ${listDisplayName}?`,
          proposedAction: action
        };
      }
    }

    if (looksLikeViewListsRequest(normalized)) {
      return {
        intent: AGENT_INTENTS.VIEW_LISTS,
        entities: {},
        draftResponse: "אין לי עדיין רשימות שמורות.",
        proposedAction: undefined
      };
    }

    if (looksLikeViewListRequest(normalized)) {
      const listName = inferListName(normalized);
      return {
        intent: AGENT_INTENTS.VIEW_LIST,
        entities: { listName },
        draftResponse: "הרשימה שלך ריקה כרגע.",
        proposedAction: undefined
      };
    }

    if (looksLikeDeleteListRequest(normalized)) {
      const listName = inferDeleteListName(normalized);
      if (listName) {
        const payload: DeleteListRequest = { listName };
        const action: ProposedAction<DeleteListRequest> = {
          id: createId("list_delete"),
          type: PROPOSED_ACTION_TYPES.DELETE_LIST,
          summary: `מחיקת רשימת ${listName}`,
          requiresConfirmation: true,
          payload,
          missingFields: []
        };
        return {
          intent: AGENT_INTENTS.DELETE_LIST,
          entities: { listName },
          draftResponse: `למחוק את רשימת ${listName}?`,
          proposedAction: action
        };
      }
      // Name missing — ask for clarification
      const clarifyAction: ProposedAction<DeleteListRequest> = {
        id: createId("list_delete"),
        type: PROPOSED_ACTION_TYPES.DELETE_LIST,
        summary: "מחיקת רשימה",
        requiresConfirmation: true,
        payload: { listName: "" },
        missingFields: ["listName"]
      };
      return {
        intent: AGENT_INTENTS.CLARIFY,
        entities: {},
        draftResponse: "איזו רשימה למחוק?",
        proposedAction: clarifyAction
      };
    }

    if (looksLikeDeleteListBareRequest(normalized)) {
      const listName = inferDeleteListBareName(normalized);
      if (listName) {
        const payload: DeleteListRequest = { listName };
        const action: ProposedAction<DeleteListRequest> = {
          id: createId("list_delete"),
          type: PROPOSED_ACTION_TYPES.DELETE_LIST,
          summary: `מחיקת רשימת ${listName}`,
          requiresConfirmation: true,
          payload,
          missingFields: []
        };
        return {
          intent: AGENT_INTENTS.DELETE_LIST,
          entities: { listName },
          draftResponse: `למחוק את רשימת ${listName}?`,
          proposedAction: action
        };
      }
    }

    if (looksLikeListRequest(normalized)) {
      const listName = inferListName(normalized);
      const items = inferListItems(normalized);
      const listDisplayName = listName ?? "קניות";
      const payload: ListRequest = { items, listName };
      const action: ProposedAction<ListRequest> = {
        id: createId("list"),
        type: PROPOSED_ACTION_TYPES.ADD_TO_LIST,
        summary: `הוספה לרשימת ${listDisplayName}`,
        requiresConfirmation: true,
        payload,
        missingFields: items.length === 0 ? ["items"] : []
      };
      if (items.length === 0) {
        return {
          intent: AGENT_INTENTS.CLARIFY,
          entities: {},
          draftResponse: `מה לרשום ברשימת ${listDisplayName}?`,
          proposedAction: action
        };
      }
      return {
        intent: AGENT_INTENTS.ADD_TO_LIST,
        entities: { items },
        draftResponse: `להוסיף לרשימת ${listDisplayName}: ${items.join(", ")}?`,
        proposedAction: action
      };
    }

    if (looksLikeAppAction(normalized)) {
      const payload: AppActionRequest = {
        appKey: "crm",
        actionName: "create_lead",
        inputs: {
          name: inferLeadName(normalized),
          company: inferCompany(normalized),
          notes: normalized
        },
        confirmationText: "ליצור ליד חדש ב-CRM"
      };
      const action: ProposedAction<AppActionRequest> = {
        id: createId("app_action"),
        type: PROPOSED_ACTION_TYPES.RUN_APP_ACTION,
        summary: "יצירת ליד חדש ב-CRM",
        requiresConfirmation: true,
        payload
      };
      return {
        intent: AGENT_INTENTS.RUN_APP_ACTION,
        entities: payload.inputs,
        draftResponse: `הבנתי שאתה רוצה ליצור ליד חדש ב-CRM עבור ${String(payload.inputs.name)}. לאשר ביצוע?`,
        proposedAction: action
      };
    }

    return {
      intent: AGENT_INTENTS.OUT_OF_SCOPE,
      entities: {},
      draftResponse: "אני יכול לעזור עם יומן, תזכורות ורשימת קניות. אפשר לנסח את הבקשה בהתאם?",
      proposedAction: undefined
    };
  }

  private async tryOpenAiInterpretation({ text, profile }: InterpretArgs): Promise<AgentInterpretation | null> {
    try {
      const systemPrompt = [
        "You are an AI assistant for a Hebrew Telegram bot.",
        "You MUST respond ONLY in valid JSON. No text outside JSON. No explanations.",
        "",
        "Format:",
        '{ "type": "chat" | "action", "message": "string", "action": { "type": "reminder" | "list" | "calendar", "payload": {} } }',
        "",
        "Rules:",
        '- If user asks a general question → type = "chat"',
        '- If user explicitly requests an action → type = "action"',
        "- message MUST always be filled (in Hebrew)",
        '- action only exists if type = "action"',
        "- NEVER include anything outside JSON",
        `- Timezone: ${profile.schedulingPreferences.timezone}`,
        "",
        "Smart defaults:",
        "If the user requests an action but misses details (like time or date):",
        "- DO NOT ask a question. INSTEAD, suggest a reasonable default.",
        "- Always include the suggested datetime in the action payload.",
        '- Example: user says "תזכיר לי להתקשר לדן" → suggest "מחר בבוקר" and include datetime: "מחר בבוקר" in payload.',
        '- Example: user says "תקבע פגישה עם דן" → suggest "מחר ב-10:00" and include datetime: "מחר ב-10:00" in payload.',
        "- Prefer near-future defaults: today or tomorrow.",
        "- Morning = 09:00, evening = 18:00.",
        "- Keep suggestions simple, short, and realistic.",
        "- Do NOT hallucinate complex details."
      ].join("\n");

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.openAiModel,
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt }]
            },
            {
              role: "user",
              content: [{ type: "input_text", text }]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "structured_response",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["chat", "action"] },
                  message: { type: "string" },
                  action: {
                    type: ["object", "null"],
                    additionalProperties: true
                  }
                },
                required: ["type", "message", "action"]
              }
            }
          }
        })
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { output_text?: string };
      if (!data.output_text) {
        return null;
      }

      const parsed = parseStructuredResponse(data.output_text, profile.schedulingPreferences.timezone);
      if (!parsed) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  private async tryOpenAiComposeInterpretation(text: string, profile: UserProfile): Promise<AgentInterpretation | null> {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.openAiModel,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: [
                    "You are a high-quality Hebrew writing assistant for Telegram.",
                    "Your job is to help the user write messages that sound natural, clear, and useful.",
                    "Do not repeat the user's prompt mechanically.",
                    "Infer recipient, purpose, and tone when possible.",
                    "Return exactly 3 polished Hebrew variants: קצר, מקצועי, חם.",
                    "Choose a recommended variant that is best for the situation.",
                    "If the user pasted a rough draft, improve and rewrite it rather than wrapping it in meta language.",
                    "Keep outputs ready to send as-is."
                  ].join(" ")
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: [
                    `User language: ${profile.language}`,
                    `Default tone: ${profile.tonePreferences.defaultTone}`,
                    `Timezone: ${profile.schedulingPreferences.timezone}`,
                    "",
                    text
                  ].join("\n")
                }
              ]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "compose_variants",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  recommendedLabel: {
                    type: "string",
                    enum: ["קצר", "מקצועי", "חם"]
                  },
                  variants: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        label: {
                          type: "string",
                          enum: ["קצר", "מקצועי", "חם"]
                        },
                        content: {
                          type: "string"
                        }
                      },
                      required: ["label", "content"]
                    }
                  }
                },
                required: ["recommendedLabel", "variants"]
              }
            }
          }
        })
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { output_text?: string };
      if (!data.output_text) {
        return null;
      }

      const parsed = JSON.parse(data.output_text) as {
        recommendedLabel: string;
        variants: ComposeVariant[];
      };
      const variants = normalizeComposeVariants(parsed.variants, parsed.recommendedLabel);
      if (variants.length === 0) {
        return null;
      }

      const recommended = variants.find((variant) => variant.label === parsed.recommendedLabel) ?? variants[0];
      const tone = inferTone(text, profile);
      const action: ProposedAction<ComposeDraftPayload> = {
        id: createId("compose"),
        type: PROPOSED_ACTION_TYPES.COMPOSE_MESSAGE,
        summary: "טיוטת הודעה מוכנה לשליחה",
        requiresConfirmation: true,
        payload: {
          tone,
          content: recommended.content,
          variants
        }
      };

      return {
        intent: AGENT_INTENTS.COMPOSE_MESSAGE,
        entities: {
          tone,
          recommendedLabel: recommended.label
        },
        draftResponse: formatComposeResponse(variants, recommended.label),
        proposedAction: action
      };
    } catch {
      return null;
    }
  }
}

interface StructuredLlmResponse {
  type: "chat" | "action";
  message: string;
  action?: {
    type: string;
    payload: Record<string, unknown>;
  } | null;
}

function parseStructuredResponse(raw: string, timezone: string): AgentInterpretation | null {
  let parsed: StructuredLlmResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed.type !== "string" || typeof parsed.message !== "string") {
    return null;
  }

  if (parsed.type !== "chat" && parsed.type !== "action") {
    return null;
  }

  if (parsed.type === "chat") {
    return {
      intent: AGENT_INTENTS.OUT_OF_SCOPE,
      entities: {},
      draftResponse: parsed.message,
      proposedAction: undefined
    };
  }

  // type === "action" — try to map to a ProposedAction for the confirmation flow
  const actionInfo = parsed.action;
  if (!actionInfo || typeof actionInfo.type !== "string") {
    logger.info("AI action missing or invalid, downgrading to chat", { action: actionInfo });
    return {
      intent: AGENT_INTENTS.OUT_OF_SCOPE,
      entities: {},
      draftResponse: parsed.message,
      proposedAction: undefined
    };
  }

  const mapped = mapAiActionToProposedAction(actionInfo, timezone);
  if (!mapped) {
    logger.info("AI action mapping failed, downgrading to chat", { actionType: actionInfo.type });
    return {
      intent: AGENT_INTENTS.OUT_OF_SCOPE,
      entities: {},
      draftResponse: parsed.message,
      proposedAction: undefined
    };
  }

  logger.info("AI action mapped successfully", { actionType: actionInfo.type, intent: mapped.intent });
  return {
    intent: mapped.intent,
    entities: mapped.entities,
    draftResponse: parsed.message,
    proposedAction: mapped.proposedAction
  };
}

function normalizeAiDatetime(raw: string, timezone: string): { iso: string | undefined; original: string } {
  if (!raw) {
    return { iso: undefined, original: raw };
  }

  // If already ISO format, use as-is
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      logger.info("datetime normalization: already ISO", { original: raw });
      return { iso: d.toISOString(), original: raw };
    }
  }

  // Parse natural language (Hebrew/English) through existing parser
  const parsed = parseNaturalLanguageDate(raw, timezone);
  if (parsed.startAt) {
    logger.info("datetime normalization: parsed successfully", { original: raw, parsed: parsed.startAt });
    return { iso: parsed.startAt, original: raw };
  }

  logger.info("datetime normalization: parsing failed", { original: raw });
  return { iso: undefined, original: raw };
}

function mapAiActionToProposedAction(
  aiAction: { type: string; payload: Record<string, unknown> },
  timezone: string
): { intent: AgentIntent; entities: Record<string, unknown>; proposedAction: ProposedAction } | null {
  const payload = aiAction.payload ?? {};

  switch (aiAction.type) {
    case "reminder": {
      const text = typeof payload.text === "string" ? payload.text : "";
      const rawDatetime = typeof payload.datetime === "string" ? payload.datetime : "";
      if (!text) return null;
      const resolved = normalizeAiDatetime(rawDatetime, timezone);
      const reminderPayload: ReminderRequest = { text, datetime: resolved.iso || undefined, inferredTimeText: rawDatetime || undefined };
      const missingFields: string[] = [];
      if (!resolved.iso) missingFields.push("startAt");
      return {
        intent: missingFields.length > 0 ? AGENT_INTENTS.CLARIFY : AGENT_INTENTS.CREATE_REMINDER,
        entities: { text, datetime: resolved.iso ?? rawDatetime },
        proposedAction: {
          id: createId("reminder"),
          type: PROPOSED_ACTION_TYPES.CREATE_REMINDER,
          summary: `תזכורת: "${text}"`,
          requiresConfirmation: true,
          payload: reminderPayload,
          missingFields
        }
      };
    }

    case "list": {
      const rawItem = payload.item ?? payload.items;
      const items: string[] = Array.isArray(rawItem)
        ? rawItem.filter((i): i is string => typeof i === "string" && i.length > 0)
        : typeof rawItem === "string" && rawItem.length > 0
          ? [rawItem]
          : [];
      if (items.length === 0) return null;
      const listName = typeof payload.listName === "string" ? payload.listName : undefined;
      const listPayload: ListRequest = { items, listName };
      const listDisplayName = listName ?? "קניות";
      return {
        intent: AGENT_INTENTS.ADD_TO_LIST,
        entities: { items },
        proposedAction: {
          id: createId("list"),
          type: PROPOSED_ACTION_TYPES.ADD_TO_LIST,
          summary: `הוספה לרשימת ${listDisplayName}`,
          requiresConfirmation: true,
          payload: listPayload,
          missingFields: []
        }
      };
    }

    case "calendar": {
      const title = typeof payload.title === "string" ? payload.title : "";
      const rawDatetime = typeof payload.datetime === "string" ? payload.datetime : "";
      if (!title) return null;
      const resolved = normalizeAiDatetime(rawDatetime, timezone);
      const calendarPayload: CalendarRequest = {
        title,
        participants: [],
        startAt: resolved.iso || undefined,
        confidence: resolved.iso ? 0.9 : 0
      };
      const missingFields: string[] = [];
      if (!resolved.iso) missingFields.push("startAt");
      return {
        intent: missingFields.length > 0 ? AGENT_INTENTS.CLARIFY : AGENT_INTENTS.SCHEDULE_MEETING,
        entities: { title },
        proposedAction: {
          id: createId("meeting"),
          type: PROPOSED_ACTION_TYPES.SCHEDULE_MEETING,
          summary: `לקבוע פגישה "${title}"`,
          requiresConfirmation: true,
          payload: calendarPayload,
          missingFields
        }
      };
    }

    default:
      return null;
  }
}

function looksLikeCalendarViewRequest(text: string): boolean {
  return matchesAny(text, CALENDAR_VIEW_TRIGGERS);
}

function looksLikeCalendarUpdateRequest(text: string): boolean {
  return matchesAny(text, CALENDAR_UPDATE_TRIGGERS);
}

function looksLikeCalendarDeleteRequest(text: string): boolean {
  return matchesAny(text, CALENDAR_DELETE_TRIGGERS);
}

function looksLikeMeetingRequest(text: string): boolean {
  if (looksLikeCalendarViewRequest(text) || looksLikeCalendarUpdateRequest(text) || looksLikeCalendarDeleteRequest(text)) {
    return false;
  }
  return matchesAny(text, MEETING_TRIGGERS);
}

function looksLikeSnoozeReminderRequest(text: string): boolean {
  return matchesAny(text, REMINDER_SNOOZE_TRIGGERS);
}

function looksLikeDeleteReminderRequest(text: string): boolean {
  return matchesAny(text, REMINDER_DELETE_TRIGGERS);
}

function looksLikeViewRemindersRequest(text: string): boolean {
  return matchesAny(text, REMINDER_VIEW_TRIGGERS);
}

function looksLikeReminderRequest(text: string): boolean {
  if (looksLikeViewRemindersRequest(text)) return false;
  return matchesAny(text, REMINDER_TRIGGERS);
}

function inferReminderText(text: string): string {
  return text
    .replace(/^(תזכיר לי|תזכור לי|remind me)\s*/i, "")
    // relative durations (minutes/hours)
    .replace(/(?:בעוד|עוד)\s+שעתיים\s*/i, "")
    .replace(/(?:בעוד|עוד)\s+שעה\s*/i, "")
    .replace(/(?:בעוד|עוד)\s+\d+\s+(?:שעות|שעה|דקות|דקה)\s*/i, "")
    // relative durations (days/weeks) — strip before date patterns
    .replace(/(?:בעוד|עוד)\s+(?:יומיים|שבוע|\d+\s+(?:ימים|שבועות))\s*/i, "")
    .replace(/\bin\s+\d+\s+(?:minutes|minute|hours|hour)\s*/i, "")
    // explicit date "ב-17.6" / "ב17.6" — strip before generic "ב-N"
    .replace(/ב-?\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s*/i, "")
    // relative day names
    .replace(/(?:היום|מחר|שלשום)\s*/i, "")
    // fuzzy time-of-day
    .replace(/(?:בבוקר|בצהריים|בערב|בלילה)\s*/i, "")
    // "בשעה N" or "at N"
    .replace(/(?:בשעה|at)\s*\d{1,2}(?::\d{2})?\s*/i, "")
    // Hebrew clock-hour words: "בחמש", "בשלוש", etc.
    .replace(/ב(?:שתים עשרה|אחת עשרה|עשר|תשע|שמונה|שבע|שש|חמש|ארבע|שלוש|שתיים|אחת)\s*/i, "")
    // "ב-N" or "בN" remaining hour references
    .replace(/ב-?\d{1,2}(?::\d{2})?\s*/i, "")
    .replace(/\d{1,2}(?:am|pm)\b/i, "")
    .trim();
}

function looksLikeComposeRequest(text: string): boolean {
  return matchesAny(text, COMPOSE_TRIGGERS);
}

function looksLikeViewListRequest(text: string): boolean {
  return matchesAny(text, LIST_VIEW_TRIGGERS);
}

function looksLikeViewListsRequest(text: string): boolean {
  return matchesAny(text, LIST_VIEW_ALL_TRIGGERS);
}

function looksLikeCreateListRequest(text: string): boolean {
  return matchesAny(text, CREATE_LIST_TRIGGERS);
}

function looksLikeRemoveFromListRequest(text: string): boolean {
  return matchesAny(text, LIST_REMOVE_TRIGGERS);
}

function inferRemoveIndex(text: string): number {
  const match = text.match(/(?:תסיר|תמחק|מחק|הסר|תוריד|הוריד)(?:\s+מרשימת\s+ה?קניות)?\s+(?:(?:את|פריט|מספר)\s+)?(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function looksLikeDeleteListRequest(text: string): boolean {
  return matchesAny(text, DELETE_LIST_TRIGGERS);
}

function looksLikeDeleteListBareRequest(text: string): boolean {
  return matchesAny(text, DELETE_LIST_BARE_TRIGGERS);
}

function looksLikeListRequest(text: string): boolean {
  if (looksLikeViewListRequest(text) || looksLikeViewListsRequest(text) || looksLikeDeleteListRequest(text) || looksLikeDeleteListBareRequest(text)) return false;
  return matchesAny(text, LIST_ADD_TRIGGERS);
}

function looksLikeRawCommand(line: string): boolean {
  return /^(?:תוסיף(?:\s+לי)?|תוסיפי|שים|תשים|תכניס|הוסף)\b/iu.test(line);
}

function inferListItems(text: string): string[] {
  return text
    .split(/[\n,،]+/)
    .map((line) => stripListCommandPrefix(line))
    .filter((line) => line.length > 0 && !looksLikeRawCommand(line));
}

function inferListName(text: string): string | undefined {
  // "לרשימת X" / "ברשימת X" / "רשימת X" — strip optional ה prefix from name
  const constructMatch = text.match(/(?:לרשימת|ברשימת|רשימת)\s+ה?([\u0590-\u05FF]+)/iu);
  if (constructMatch?.[1]) return constructMatch[1].trim();
  // "ל<name>" immediately after a list-action verb: "תוסיף לקניות", "שים לסופר"
  const verbPrepMatch = text.match(/(?:תוסיף|תוסיפי|שים|תשים|תכניס|הוסף)\s+ל([\u0590-\u05FF]{2,})(?:\s|$)/iu);
  if (verbPrepMatch?.[1]) return verbPrepMatch[1].trim();
  return undefined;
}

function inferDeleteListName(text: string): string | undefined {
  // "רשימת X" — strip optional ה prefix from name
  const match = text.match(/ה?רשימת\s+ה?([\u0590-\u05FF]+)/iu);
  return match?.[1]?.trim();
}

function inferDeleteListBareName(text: string): string | undefined {
  // "תמחק [לי] [את] [ה]<name>" — no "רשימה" word
  const match = text.match(/^(?:מחק|תמחק|הסר|תסיר|תוריד)\s+(?:לי\s+)?(?:את\s+)?ה?([\u0590-\u05FF]+)$/iu);
  return match?.[1]?.trim();
}

function inferNewListName(text: string): string | undefined {
  // "בשם X" takes priority
  const namedMatch = text.match(/בשם\s+:?\s*([\u0590-\u05FF]+)/iu);
  if (namedMatch?.[1]) return namedMatch[1].trim();
  // "רשימת X" — construct form with explicit name
  const constructMatch = text.match(/רשימת\s+ה?([\u0590-\u05FF]+)/iu);
  if (constructMatch?.[1]) return constructMatch[1].trim();
  return undefined;
}

export function stripListCommandPrefix(line: string): string {
  return line
    // verb + list target: "תוסיף לרשימת X" / "תוסיף לקניות" / "שים לסופר" / "תכניס לרשימת X"
    .replace(/^(?:תיצור לי|תיצור|תפתח|תוסיף לי|תוסיף|תוסיפי|שים|תשים|תכניס|הוסף)\s+(?:[לב]רשימת\s+ה?[\u0590-\u05FF]+|רשימת\s+ה?[\u0590-\u05FF]+|ל[\u0590-\u05FF]+)\s*/iu, "")
    // verb alone (list target absent or already stripped): "תוסיף X" / "שים X"
    .replace(/^(?:תוסיף לי|תוסיף|תוסיפי|שים|תשים|תכניס|הוסף)\s+/iu, "")
    // list target at start: "לרשימת X" / "ברשימת X"
    .replace(/^(?:[לב]רשימת)\s+ה?[\u0590-\u05FF]+[:\s]*/iu, "")
    // bare "לX:" at start (shorthand like "לקניות: חלב") — colon is required so
    // infinitive verbs like "לשלוח", "לקנות" in the item text are NOT stripped
    .replace(/^ל[\u0590-\u05FF]+:\s*/u, "")
    // bare "קניות" / "רשימת קניות" at start
    .replace(/^(?:רשימת\s+קניות|קניות)\s*/i, "")
    // list target embedded mid-line: "X לרשימת Y Z" → "X Z"
    .replace(/\s+(?:[לב]רשימת)\s+ה?[\u0590-\u05FF]+\s*/iu, " ")
    .trim();
}

function looksLikeAppAction(text: string): boolean {
  return matchesAny(text, APP_ACTION_TRIGGERS);
}

function inferMeetingTitle(text: string): string {
  const quotedTitle = text.match(/[\"״](.+?)[\"״]/);
  if (quotedTitle?.[1]) {
    return quotedTitle[1].trim();
  }

  const withPerson = text.match(/עם\s+([\u0590-\u05FFA-Za-z]+)/);
  if (withPerson) {
    return `פגישה עם ${withPerson[1]}`;
  }
  if (/פגישה\s+משפחתית/.test(text)) {
    return "פגישה משפחתית";
  }

  const cleaned = text
    // strip scheduling verbs + optional "לי" anywhere in the string (handles reordered phrasing)
    .replace(/\b(?:תקבע|תקבעי|קבע|קבעי|תזמן|זמן|תרשום|הוסף|תוסיף|תכניס|כנס|תיצור|צור)\s*(?:לי\s+)?/gi, "")
    .replace(/\b(ביומן|ליומן|פגישה|פגישת|אירוע)\b/gi, "")
    .replace(/\b(למחר|מחר|היום|מחרתיים|השבוע)\b/gi, "")
    .replace(/(?:בשעה)\s*\d{1,2}(?::\d{2})?/gi, "")
    .replace(/ב-?\d{1,2}\.\d{1,2}(?:\.\d{2,4})?/g, "")
    // strip standalone hour refs like "ב-14" / "ב-9:30" (not followed by a dot, to avoid eating dates)
    .replace(/ב-?\d{1,2}(?::\d{2})?(?!\.\d)/g, "")
    .replace(/\b(בערב|בבוקר|בצהריים|בלילה)\b/gi, "")
    .replace(/[\"״]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned) {
    return cleaned;
  }

  return "פגישה חדשה";
}

function inferParticipants(text: string): string[] {
  const participant = text.match(/עם\s+([\u0590-\u05FFA-Za-z0-9._%+-]+@[\u0590-\u05FFA-Za-z0-9.-]+\.[A-Za-z]{2,}|[\u0590-\u05FFA-Za-z]+)/);
  return participant ? [participant[1]] : [];
}

function inferLeadName(text: string): string {
  const match = text.match(/(?:עבור|ליד|lead)\s+([\u0590-\u05FFA-Za-z ]+)/i);
  return match?.[1]?.trim() || "Lead from Telegram";
}

function inferCompany(text: string): string {
  const match = text.match(/(?:מחברת|company)\s+([\u0590-\u05FFA-Za-z ]+)/i);
  return match?.[1]?.trim() || "Unknown";
}

function inferTone(text: string, profile: UserProfile): Tone {
  if (/(?:משפחתי|חבר|אישי|אישית|אמא|אבא|אחות)/u.test(text)) {
    return "personal";
  }
  return profile.tonePreferences.defaultTone;
}

function buildDraftMessage(text: string, tone: Tone): string {
  const directCompose = extractDirectComposeMessage(text, tone);
  if (directCompose) {
    return directCompose;
  }

  const rewrite = extractRewriteCandidate(text);
  if (rewrite) {
    return rewriteMessage(rewrite, tone);
  }

  if (tone === "personal") {
    return `היי, רציתי לעדכן לגבי ${normalizeTopic(text)}. תגיד לי אם מתאים לך ואשמח לתאם.`;
  }
  return `שלום, אשמח לתאם בנושא ${normalizeTopic(text)}. אם מתאים, אפשר לקבוע זמן קצר להמשך.`;
}

function buildDraftVariants(text: string, tone: Tone): ComposeVariant[] {
  const directCompose = extractDirectComposeMessage(text, tone);
  if (directCompose) {
    return buildVariantsFromBase(directCompose, tone);
  }

  const rewrite = extractRewriteCandidate(text);
  if (rewrite) {
    return buildVariantsFromBase(rewriteMessage(rewrite, tone), tone);
  }

  const topic = normalizeTopic(text);
  const short = tone === "personal"
    ? `היי, אני מאחר בכ-20 דקות בנושא ${topic}.`
    : `שלום, אני מתעכב בכ-20 דקות בנושא ${topic}.`;
  return buildVariantsFromBase(short, tone);
}

function normalizeTopic(text: string): string {
  return text
    .replace(/^(תכתוב|תכתבי|נסח|נסחי|תנסח|תנסחי|תכתוב לי|תנסח לי)\s*/i, "")
    .replace(/^(הודעה|מייל)\s+/i, "")
    .replace(/^(אישית|אישי|מקצועית|מקצועי)\s+/i, "")
    .replace(/^\s*ל[\u0590-\u05FFA-Za-z]+\s+/i, "")
    .trim() || "הנושא שביקשת";
}

function buildComposeInterpretation(text: string, profile: UserProfile): AgentInterpretation {
  const tone = inferTone(text, profile);
  const variants = buildDraftVariants(text, tone);
  const draftedMessage = formatComposeResponse(variants);
  const action: ProposedAction<ComposeDraftPayload> = {
    id: createId("compose"),
    type: PROPOSED_ACTION_TYPES.COMPOSE_MESSAGE,
    summary: "טיוטת הודעה מוכנה לשליחה",
    requiresConfirmation: true,
    payload: {
      tone,
      content: variants[0]?.content ?? "",
      variants
    }
  };

  return {
    intent: AGENT_INTENTS.COMPOSE_MESSAGE,
    entities: {
      tone
    },
    draftResponse: draftedMessage,
    proposedAction: action
  };
}

function extractRewriteCandidate(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length >= 2) {
    return lines.slice(1).join(" ");
  }

  const separatorMatch = text.match(/[:\-]\s*(.+)$/s);
  if (separatorMatch?.[1]) {
    return separatorMatch[1].trim();
  }

  return null;
}

function rewriteMessage(raw: string, tone: Tone): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();

  if (tone === "personal") {
    return cleaned
      .replace(/^הי\b/, "היי")
      .replace(/\bאני לא אגיע היום\b/, "לא אוכל להגיע היום");
  }

  return cleaned
    .replace(/^הי\b/, "היי")
    .replace(/\bאני לא אגיע היום\b/, "לא אוכל להגיע היום");
}

function extractDirectComposeMessage(text: string, tone: Tone): string | null {
  const match = text.match(
    /^(?:תכתוב|תכתבי|נסח|נסחי|תנסח|תנסחי)(?:\s+לי)?\s+(?:הודעה|מייל)?\s*(?:קצרה|קצר|אישית|אישי|מקצועית|מקצועי)?\s*ל(?<recipient>[\u0590-\u05FFA-Za-z]+)\s+(?<message>.+)$/u
  );

  if (!match?.groups?.recipient || !match.groups.message) {
    return null;
  }

  const recipient = match.groups.recipient.trim();
  const message = rewriteMessage(match.groups.message.trim(), tone).replace(/[.]+$/u, "");

  if (tone === "personal") {
    return `היי ${recipient}, ${message}.`;
  }

  return `שלום ${recipient}, ${message}.`;
}

function buildVariantsFromBase(base: string, tone: Tone): ComposeVariant[] {
  const normalized = base.replace(/\s+/g, " ").trim().replace(/[.]+$/u, "");

  return [
    {
      label: "קצר",
      content: `${normalized}.`
    },
    {
      label: "מקצועי",
      content: toProfessionalVariant(normalized)
    },
    {
      label: tone === "personal" ? "חם" : "ידידותי",
      content: toWarmVariant(normalized, tone)
    }
  ];
}

function toProfessionalVariant(text: string): string {
  return text
    .replace(/^היי\b/u, "שלום")
    .replace(/^הי\b/u, "שלום")
    .replace(/\bאני מאחר\b/u, "אני צפוי לאחר")
    .replace(/\bאני מתעכב\b/u, "אני צפוי להתעכב")
    .replace(/[.]*$/u, ".");
}

function toWarmVariant(text: string, tone: Tone): string {
  const warmed = text
    .replace(/^שלום\b/u, tone === "personal" ? "היי" : "שלום")
    .replace(/\bאני צפוי לאחר\b/u, "אני קצת מאחר")
    .replace(/\bאני צפוי להתעכב\b/u, "אני קצת מתעכב")
    .replace(/[.]*$/u, "");

  return tone === "personal" ? `${warmed}, תודה על ההבנה.` : `${warmed}. תודה על ההבנה.`;
}

function formatComposeResponse(variants: ComposeVariant[], recommendedLabel?: string): string {
  return variants
    .map((variant) => {
      const header = variant.label === recommendedLabel ? `${variant.label} (מומלץ)` : variant.label;
      return `${header}:\n${variant.content}`;
    })
    .join("\n\n");
}

function normalizeComposeVariants(variants: ComposeVariant[], recommendedLabel: string): ComposeVariant[] {
  const expectedLabels: Array<ComposeVariant["label"]> = ["קצר", "מקצועי", "חם"];
  const normalized = expectedLabels
    .map((label) => variants.find((variant) => variant.label === label))
    .filter((variant): variant is ComposeVariant => Boolean(variant?.content?.trim()))
    .map((variant) => ({
      label: variant.label,
      content: variant.content.trim()
    }));

  if (normalized.length === expectedLabels.length) {
    return normalized;
  }

  const fallback = variants
    .filter((variant) => variant.content?.trim())
    .slice(0, 3)
    .map((variant, index) => ({
      label: expectedLabels[index] ?? variant.label,
      content: variant.content.trim()
    }));

  if (fallback.length === 3) {
    return fallback;
  }

  const seed = fallback[0]?.content ?? "";
  return expectedLabels.map((label) => ({
    label,
    content: seed
  })).filter((variant) => variant.content);
}
