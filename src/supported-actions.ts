export const SUPPORTED_INTENT_NAMES = [
  "add_calendar_event",
  "add_to_list",
  "view_list",
  "remove_from_list",
  "create_reminder",
  "view_reminders"
] as const;

export const SUPPORTED_ACTION_NAMES = SUPPORTED_INTENT_NAMES;

export type SupportedIntentName = typeof SUPPORTED_INTENT_NAMES[number];
export type SupportedActionName = typeof SUPPORTED_ACTION_NAMES[number];

export const PROPOSED_ACTION_TYPES = {
  COMPOSE_MESSAGE: "compose_message",
  SCHEDULE_MEETING: "schedule_meeting",
  RUN_APP_ACTION: "run_app_action",
  CREATE_REMINDER: "create_reminder",
  CREATE_LIST: "create_list",
  ADD_TO_LIST: "add_to_list",
  REMOVE_FROM_LIST: "remove_from_list",
  DELETE_LIST: "delete_list",
  VIEW_LIST: "view_list",
  VIEW_LISTS: "view_lists",
  VIEW_REMINDERS: "view_reminders",
  DELETE_REMINDER: "delete_reminder",
  SNOOZE_REMINDER: "snooze_reminder"
} as const;

export type ProposedActionType = typeof PROPOSED_ACTION_TYPES[keyof typeof PROPOSED_ACTION_TYPES];

export const AGENT_INTENTS = {
  ...PROPOSED_ACTION_TYPES,
  CLARIFY: "clarify",
  OUT_OF_SCOPE: "out_of_scope"
} as const;

export type AgentIntent = typeof AGENT_INTENTS[keyof typeof AGENT_INTENTS];

export const AGENT_INTENT_VALUES = [
  AGENT_INTENTS.COMPOSE_MESSAGE,
  AGENT_INTENTS.SCHEDULE_MEETING,
  AGENT_INTENTS.RUN_APP_ACTION,
  AGENT_INTENTS.CREATE_REMINDER,
  AGENT_INTENTS.CREATE_LIST,
  AGENT_INTENTS.ADD_TO_LIST,
  AGENT_INTENTS.REMOVE_FROM_LIST,
  AGENT_INTENTS.DELETE_LIST,
  AGENT_INTENTS.VIEW_LIST,
  AGENT_INTENTS.VIEW_LISTS,
  AGENT_INTENTS.VIEW_REMINDERS,
  AGENT_INTENTS.DELETE_REMINDER,
  AGENT_INTENTS.SNOOZE_REMINDER,
  AGENT_INTENTS.CLARIFY,
  AGENT_INTENTS.OUT_OF_SCOPE
] as const;
