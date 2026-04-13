import { Reminder } from "../types.js";
import { logger } from "../utils/logger.js";
import { ReminderService } from "./reminder-service.js";

export class ReminderExecutionEngine {
  private running = false;

  constructor(private readonly reminders: ReminderService) {}

  listDueReminders(referenceTime = new Date()): Reminder[] {
    return this.reminders.listDueReminders(referenceTime);
  }

  async runDueReminders(
    executeReminder: (reminder: Reminder) => Promise<void>,
    referenceTime = new Date()
  ): Promise<Reminder[]> {
    // Guard against overlapping executions (e.g. slow send + short poll interval)
    if (this.running) {
      logger.warn("reminder execution already in progress, skipping tick");
      return [];
    }
    this.running = true;

    const dueReminders = this.listDueReminders(referenceTime);
    const processed: Reminder[] = [];

    for (const reminder of dueReminders) {
      // Mark sent first to prevent duplicate delivery if executeReminder throws
      this.reminders.markReminderSent(reminder.id);
      try {
        await executeReminder(reminder);
        processed.push(reminder);
      } catch (err) {
        logger.error("reminder execution failed", {
          reminderId: reminder.id,
          error: err instanceof Error ? err.message : String(err)
        });
        // Reminder stays "sent" — not re-queued, no duplicate delivery
      }
    }

    this.running = false;
    return processed;
  }
}
