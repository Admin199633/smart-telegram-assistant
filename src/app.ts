import crypto from "node:crypto";
import express from "express";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { AGENT_INTENTS, PROPOSED_ACTION_TYPES } from "./supported-actions.js";
import { ActionRegistry, defaultActions } from "./services/action-registry.js";
import { AppActionService } from "./services/app-action-service.js";
import { CalendarService } from "./services/calendar-service.js";
import { DatabaseService } from "./services/database.js";
import { ListService } from "./services/list-service.js";
import { LlmService } from "./services/llm-service.js";
import { MemoryStore } from "./services/memory-store.js";
import { OrchestratorService } from "./services/orchestrator.js";
import { ReminderExecutionEngine } from "./services/reminder-execution-engine.js";
import { ReminderService } from "./services/reminder-service.js";
import { TelegramService } from "./services/telegram-service.js";
import { WorklogService } from "./services/worklog-service.js";
import { AgentInterpretation, TelegramUpdate } from "./types.js";
import { formatDateTime } from "./utils/time.js";
import { logger } from "./utils/logger.js";

const interpretSchema = z.object({
  userId: z.string(),
  text: z.string().min(1)
});

const confirmSchema = z.object({
  userId: z.string(),
  actionId: z.string()
});

const oauthStartSchema = z.object({
  userId: z.string(),
  chatId: z.coerce.number().optional(),
  mode: z.enum(["json", "redirect"]).optional()
});

const telegramSetupSchema = z.object({
  webhookUrl: z.string().url().optional()
});

const createEventSchema = z.object({
  title: z.string(),
  participants: z.array(z.string()).default([]),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  inferredTimeText: z.string().optional(),
  confidence: z.number()
});

const appActionBodySchema = z.object({
  inputs: z.record(z.unknown())
});

export function createApp() {
  const app = express();
  const database = new DatabaseService(config.databaseUrl);
  const lists = new ListService();
  const reminders = new ReminderService();
  const reminderExecution = new ReminderExecutionEngine(reminders);
  const memory = new MemoryStore();
  const registry = new ActionRegistry(defaultActions);
  const appActionService = new AppActionService(registry);
  const calendarService = new CalendarService();
  const llmService = new LlmService();
  const orchestrator = new OrchestratorService(
    memory,
    llmService,
    calendarService,
    appActionService,
    config.defaultTimezone,
    reminders,
    lists
  );
  const worklog = new WorklogService();
  const telegram = new TelegramService();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      actions: registry.list().length
    });
  });

  app.post("/agent/interpret", async (req, res, next) => {
    try {
      const payload = interpretSchema.parse(req.body);
      const interpretation = await orchestrator.interpret(payload.userId, payload.text);
      res.json(interpretation);
    } catch (error) {
      next(error);
    }
  });

  app.post("/agent/confirm", async (req, res, next) => {
    try {
      const payload = confirmSchema.parse(req.body);
      const result = await orchestrator.confirm(payload.userId, payload.actionId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/integrations/calendar/create-event", async (req, res, next) => {
    try {
      const payload = createEventSchema.parse(req.body);
      const result = await calendarService.createEvent(payload);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/integrations/apps/:appKey/:actionName", async (req, res, next) => {
    try {
      const params = z.object({
        appKey: z.string(),
        actionName: z.string()
      }).parse(req.params);
      const body = appActionBodySchema.parse(req.body);
      const definition = registry.get(params.appKey, params.actionName);
      if (!definition) {
        res.status(404).json({
          error: "Action not found"
        });
        return;
      }

      const missingFields = Object.keys(definition.inputSchema).filter((field) => !(field in body.inputs));
      if (missingFields.length > 0) {
        res.status(400).json({
          error: "Missing inputs",
          missingFields
        });
        return;
      }

      const result = await appActionService.execute({
        appKey: params.appKey,
        actionName: params.actionName,
        inputs: body.inputs,
        confirmationText: definition.confirmationText
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/telegram/webhook", async (req, res, next) => {
    try {
      if (config.telegramWebhookSecret) {
        const secret = req.header("x-telegram-bot-api-secret-token");
        if (secret !== config.telegramWebhookSecret) {
          res.status(401).json({
            error: "Invalid secret"
          });
          return;
        }
      }

      const update = req.body as TelegramUpdate;
      const incomingText = update.message?.text;
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      const userId = String(update.message?.from?.id ?? update.callback_query?.from.id ?? "");

      memory.addAuditEntry({
        id: `tg_${update.update_id}`,
        type: "telegram_update",
        userId,
        payload: update as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString()
      });

      const MENU_TRIGGERS = new Set([
        "אפשרויות", "אופציות", "תפריט", "תפריט ראשי", "פתח תפריט",
        "תפתח תפריט", "תציג אפשרויות", "תראה אפשרויות",
        "מה אפשר לעשות", "מה אתה יודע לעשות",
        "עזרה", "help", "menu", "options"
      ]);

      if (incomingText && MENU_TRIGGERS.has(incomingText.trim()) && chatId) {
        await telegram.sendMessage(chatId, "מה תרצה לעשות?", {
          inline_keyboard: [[
            { text: "רשימות", callback_data: "menu:lists" },
            { text: "תזכורות", callback_data: "menu:reminders" }
          ]]
        });
        res.json({ ok: true });
        return;
      }

      if (incomingText && chatId) {
        const interpretation = await orchestrator.interpret(userId, incomingText);
        const markup = buildTelegramMarkup({
          interpretation,
          userId,
          chatId,
          hasGoogleCalendarAuth: Boolean(memory.getGoogleTokens(userId)),
          publicBaseUrl: config.publicBaseUrl
        });
        await telegram.sendMessage(chatId, interpretation.draftResponse, markup, "HTML");
      }

      const callbackQuery = update.callback_query;
      const callbackData = callbackQuery?.data;

      // Answer every callback immediately — before any async work — to avoid the
      // Telegram 10-second timeout ("query is too old").
      if (callbackQuery) {
        await telegram.answerCallbackQuery(callbackQuery.id);
      }

      if (callbackData?.startsWith("confirm:") && chatId && callbackQuery) {
        const actionId = callbackData.replace("confirm:", "");
        logger.info("confirm callback received", { userId, actionId, chatId });

        try {
          const result = await orchestrator.confirm(userId, actionId, chatId);
          logger.info("confirm resolved", { userId, actionId, status: result.status });

          if (result.status === "not_found") {
            await telegram.sendMessage(chatId, "לא מצאתי פעולה ממתינה לאישור. אולי פג תוקף הבקשה?");
          } else {
            const isSkipped = typeof result.result === "object" && result.result !== null &&
              (result.result as Record<string, unknown>).status === "skipped";
            if (isSkipped) {
              const connectUrl = new URL("/oauth/google/start", config.publicBaseUrl);
              connectUrl.searchParams.set("userId", userId);
              connectUrl.searchParams.set("chatId", String(chatId));
              await telegram.sendMessage(
                chatId,
                "כדי ליצור אירועים ביומן יש להתחבר ל-Google Calendar.",
                { inline_keyboard: [[{ text: "התחבר ליומן", url: connectUrl.toString() }]] }
              );
            } else {
              await telegram.sendMessage(chatId, result.message);
            }
          }
        } catch (confirmError) {
          const message = confirmError instanceof Error ? confirmError.message : "Unknown error";
          logger.error("confirm failed", { userId, actionId, error: message });

          const isCalendarFailure = confirmError instanceof Error &&
            (confirmError as Error & { calendarFailure?: boolean }).calendarFailure === true;

          if (isCalendarFailure) {
            const connectUrl = new URL("/oauth/google/start", config.publicBaseUrl);
            connectUrl.searchParams.set("userId", userId);
            connectUrl.searchParams.set("chatId", String(chatId));
            await telegram.sendMessage(
              chatId,
              "אירעה שגיאה בפעולת היומן. ניתן להתחבר מחדש ולנסות שוב.",
              {
                inline_keyboard: [[{ text: "התחבר ליומן", url: connectUrl.toString() }]]
              }
            ).catch(() => undefined);
          } else {
            await telegram.sendMessage(chatId, "אירעה שגיאה בעת ביצוע הפעולה. אנא נסה שוב.").catch(() => undefined);
          }
        }
      }

      if (callbackData?.startsWith("clarify:") && chatId && callbackQuery) {
        const answer = callbackData === "clarify:yes" ? "כן" : "לא";
        const interpretation = await orchestrator.interpret(userId, answer);
        const markup = buildTelegramMarkup({
          interpretation,
          userId,
          chatId,
          hasGoogleCalendarAuth: Boolean(memory.getGoogleTokens(userId)),
          publicBaseUrl: config.publicBaseUrl
        });
        await telegram.sendMessage(chatId, interpretation.draftResponse, markup, "HTML");
      }

      if (callbackData?.startsWith("menu:") && chatId && callbackQuery) {

        if (callbackData === "menu:lists") {
          await telegram.sendMessage(chatId, "בחר פעולה לרשימות:", {
            inline_keyboard: [
              [
                { text: "הוסף לרשימה", callback_data: "menu:list:add" },
                { text: "הצג רשימה", callback_data: "menu:list:view" }
              ],
              [
                { text: "כל הרשימות", callback_data: "menu:list:view_all" },
                { text: "הסר פריט", callback_data: "menu:list:remove" }
              ]
            ]
          });
        } else if (callbackData === "menu:reminders") {
          await telegram.sendMessage(chatId, "בחר פעולה לתזכורות:", {
            inline_keyboard: [
              [
                { text: "תזכורת חדשה", callback_data: "menu:reminder:create" },
                { text: "התזכורות שלי", callback_data: "menu:reminder:view" }
              ],
              [
                { text: "מחק תזכורת", callback_data: "menu:reminder:delete" },
                { text: "דחה תזכורת", callback_data: "menu:reminder:snooze" }
              ]
            ]
          });

        // ── הוסף לרשימה ──────────────────────────────────────────────────
        } else if (callbackData === "menu:list:add") {
          const userLists = lists.listLists(userId);
          if (userLists.length === 0) {
            await telegram.sendMessage(chatId, "איך תרצה לקרוא לרשימה החדשה?");
          } else {
            await telegram.sendMessage(chatId, "לאיזו רשימה להוסיף?", {
              inline_keyboard: userLists.map((l, i) => [
                { text: l.name, callback_data: `menu:list:add:${i}` }
              ])
            });
          }
        } else if (callbackData.startsWith("menu:list:add:")) {
          const listIdx = parseInt(callbackData.slice("menu:list:add:".length), 10);
          const list = lists.listLists(userId)[listIdx];
          if (list) {
            const interpretation = await orchestrator.interpret(userId, `הוסף לרשימת ${list.name}`);
            const markup = buildTelegramMarkup({
              interpretation,
              userId,
              chatId,
              hasGoogleCalendarAuth: Boolean(memory.getGoogleTokens(userId)),
              publicBaseUrl: config.publicBaseUrl
            });
            await telegram.sendMessage(chatId, interpretation.draftResponse, markup, "HTML");
          }

        // ── הצג רשימה ────────────────────────────────────────────────────
        } else if (callbackData === "menu:list:view") {
          const userLists = lists.listLists(userId);
          if (userLists.length === 0) {
            await telegram.sendMessage(chatId, "אין לך עדיין רשימות שמורות.");
          } else if (userLists.length === 1) {
            const list = userLists[0];
            const items = lists.listItems(list.id).filter((i) => i.status === "active");
            const text = items.length === 0
              ? `רשימת ${list.name} ריקה כרגע.`
              : `רשימת ${list.name}:\n${items.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n")}`;
            await telegram.sendMessage(chatId, text);
          } else {
            await telegram.sendMessage(chatId, "איזו רשימה להציג?", {
              inline_keyboard: userLists.map((l, i) => [
                { text: l.name, callback_data: `menu:list:view:${i}` }
              ])
            });
          }
        } else if (callbackData.startsWith("menu:list:view:")) {
          const listIdx = parseInt(callbackData.slice("menu:list:view:".length), 10);
          const list = lists.listLists(userId)[listIdx];
          if (list) {
            const items = lists.listItems(list.id).filter((i) => i.status === "active");
            const text = items.length === 0
              ? `רשימת ${list.name} ריקה כרגע.`
              : `רשימת ${list.name}:\n${items.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n")}`;
            await telegram.sendMessage(chatId, text);
          }

        // ── הסר פריט ─────────────────────────────────────────────────────
        } else if (callbackData === "menu:list:remove") {
          const userLists = lists.listLists(userId);
          if (userLists.length === 0) {
            await telegram.sendMessage(chatId, "אין לך עדיין רשימות שמורות.");
          } else {
            await telegram.sendMessage(chatId, "מאיזו רשימה להסיר פריט?", {
              inline_keyboard: userLists.map((l, i) => [
                { text: l.name, callback_data: `menu:list:remove:${i}` }
              ])
            });
          }
        } else if (callbackData.startsWith("menu:list:removeitem:")) {
          const rest = callbackData.slice("menu:list:removeitem:".length);
          const colonIdx = rest.indexOf(":");
          const listIdx = parseInt(rest.slice(0, colonIdx), 10);
          const itemIdx = parseInt(rest.slice(colonIdx + 1), 10);
          const list = lists.listLists(userId)[listIdx];
          if (list && !isNaN(itemIdx)) {
            const removed = lists.removeItemByIndex(list.id, itemIdx);
            await telegram.sendMessage(chatId, removed ? `פריט הוסר מרשימת ${list.name}.` : "לא הצלחתי להסיר את הפריט.");
          }
        } else if (callbackData.startsWith("menu:list:remove:")) {
          const listIdx = parseInt(callbackData.slice("menu:list:remove:".length), 10);
          const list = lists.listLists(userId)[listIdx];
          if (list) {
            const items = lists.listItems(list.id).filter((i) => i.status === "active");
            if (items.length === 0) {
              await telegram.sendMessage(chatId, `רשימת ${list.name} ריקה כרגע.`);
            } else {
              await telegram.sendMessage(chatId, `איזה פריט להסיר מרשימת ${list.name}?`, {
                inline_keyboard: items.map((item, idx) => [
                  { text: `${idx + 1}. ${item.text}`, callback_data: `menu:list:removeitem:${listIdx}:${idx + 1}` }
                ])
              });
            }
          }

        // ── מחק / דחה תזכורת ─────────────────────────────────────────────
        } else if (callbackData === "menu:reminder:delete" || callbackData === "menu:reminder:snooze") {
          const isDelete = callbackData === "menu:reminder:delete";
          const pending = reminders.listReminders(userId)
            .filter((r) => r.status === "pending")
            .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

          if (pending.length === 0) {
            await telegram.sendMessage(chatId, "אין לך תזכורות פעילות כרגע.");
          } else {
            const tz = config.defaultTimezone;
            const listText = pending
              .map((r, idx) => `${idx + 1}. ${r.text} — ${formatDateTime(r.datetime, "he-IL", tz)}`)
              .join("\n");
            const triggerText = isDelete ? "מחק תזכורת" : "דחה תזכורת";
            const interpretation = await orchestrator.interpret(userId, triggerText);
            await telegram.sendMessage(chatId, `התזכורות שלך:\n${listText}\n\n${interpretation.draftResponse}`);
          }

        } else {
          const MENU_ACTION_MAP: Record<string, string> = {
            "menu:list:view_all": "תציג לי את כל הרשימות",
            "menu:reminder:create": "תזכיר לי",
            "menu:reminder:view": "מה התזכורות שלי"
          };
          const routedText = MENU_ACTION_MAP[callbackData];
          if (routedText) {
            const interpretation = await orchestrator.interpret(userId, routedText);
            const markup = buildTelegramMarkup({
              interpretation,
              userId,
              chatId,
              hasGoogleCalendarAuth: Boolean(memory.getGoogleTokens(userId)),
              publicBaseUrl: config.publicBaseUrl
            });
            await telegram.sendMessage(chatId, interpretation.draftResponse, markup, "HTML");
          }
        }
      }

      res.json({
        ok: true
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/oauth/google/start", (req, res) => {
    const payload = oauthStartSchema.parse(req.query);
    const state = crypto.randomUUID();
    const authorizationUrl = calendarService.getAuthorizationUrl(state);
    memory.saveOAuthState(state, {
      userId: payload.userId,
      chatId: payload.chatId,
      createdAt: new Date().toISOString()
    });

    if (payload.mode === "json") {
      res.json({
        authorizationUrl
      });
      return;
    }

    res.redirect(302, authorizationUrl);
  });

  app.get("/oauth/google/callback", async (req, res, next) => {
    try {
      const payload = z.object({
        code: z.string(),
        state: z.string()
      }).parse(req.query);
      const state = memory.consumeOAuthState(payload.state);
      if (!state) {
        res.status(400).send("Invalid or expired OAuth state");
        return;
      }

      const tokens = await calendarService.exchangeCodeForTokens(payload.code);
      memory.saveGoogleTokens(state.userId, tokens);
      logger.info("google tokens stored on reconnect", { userId: state.userId, hasChatId: Boolean(state.chatId) });

      if (state.chatId) {
        await telegram.sendMessage(
          state.chatId,
          "חיבור Google Calendar הושלם. עכשיו אפשר לאשר יצירת פגישות ישירות מהבוט."
        );
      }

      res.send("Google Calendar connected successfully. You can return to Telegram.");
    } catch (error) {
      next(error);
    }
  });

  app.post("/telegram/setup-webhook", async (req, res, next) => {
    try {
      const payload = telegramSetupSchema.parse(req.body ?? {});
      const webhookUrl = payload.webhookUrl ?? `${config.publicBaseUrl}/telegram/webhook`;
      const result = await telegram.setWebhook(webhookUrl);
      res.json({
        webhookUrl,
        result
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/telegram/webhook-info", async (_req, res, next) => {
    try {
      const result = await telegram.getWebhookInfo();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  setInterval(() => {
    reminderExecution.runDueReminders(async (reminder) => {
      const target = reminder.chatId ?? Number(reminder.userId);
      if (!target) {
        logger.warn("reminder has no chatId, skipping send", { reminderId: reminder.id });
        return;
      }
      logger.info("sending due reminder", { reminderId: reminder.id, userId: reminder.userId });
      await telegram.sendMessage(target, `⏰ תזכורת: ${reminder.text}`);
    }).catch((err: unknown) => {
      logger.error("reminder poll error", { error: err instanceof Error ? err.message : String(err) });
    });
  }, 30_000);

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: "Invalid request",
        issues: error.issues.map((i) => ({ path: i.path, message: i.message }))
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("request error", {
      method: req.method,
      path: req.path,
      error: message
    });
    res.status(500).json({
      error: message
    });
  });

  return {
    app,
    services: {
      database,
      lists,
      reminders,
      reminderExecution,
      memory,
      registry,
      appActionService,
      calendarService,
      llmService,
      orchestrator,
      worklog,
      telegram
    }
  };
}

export function buildTelegramMarkup(args: {
  interpretation: AgentInterpretation;
  userId: string;
  chatId: number;
  hasGoogleCalendarAuth: boolean;
  publicBaseUrl: string;
}): Record<string, unknown> | undefined {
  const { interpretation, userId, chatId, hasGoogleCalendarAuth, publicBaseUrl } = args;
  if (!interpretation.proposedAction || interpretation.intent === AGENT_INTENTS.OUT_OF_SCOPE) {
    return undefined;
  }

  if (interpretation.intent === AGENT_INTENTS.CLARIFY) {
    if (interpretation.proposedAction.missingFields?.includes("createList")) {
      return {
        inline_keyboard: [[
          { text: "כן", callback_data: "clarify:yes" },
          { text: "לא", callback_data: "clarify:no" }
        ]]
      };
    }
    return undefined;
  }

  const buttons: Array<Array<Record<string, string>>> = [[
    {
      text: "אשר",
      callback_data: `confirm:${interpretation.proposedAction.id}`
    }
  ]];

  if (
    interpretation.proposedAction.type === PROPOSED_ACTION_TYPES.SCHEDULE_MEETING &&
    !hasGoogleCalendarAuth &&
    !(interpretation.proposedAction.missingFields?.length)
  ) {
    const url = new URL("/oauth/google/start", publicBaseUrl);
    url.searchParams.set("userId", userId);
    url.searchParams.set("chatId", String(chatId));
    buttons.push([
      {
        text: "חבר יומן",
        url: url.toString()
      }
    ]);
  }

  return {
    inline_keyboard: buttons
  };
}
