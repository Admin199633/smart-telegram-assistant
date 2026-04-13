import { Reminder } from "../types.js";
import { createId } from "../utils/id.js";

export class ReminderService {
  private readonly remindersByUser = new Map<string, Reminder[]>();

  listReminders(userId: string): Reminder[] {
    return [...(this.remindersByUser.get(userId) ?? [])];
  }

  getReminder(userId: string, reminderId: string): Reminder | undefined {
    return this.listReminders(userId).find((reminder) => reminder.id === reminderId);
  }

  createReminder(userId: string, text: string, datetime: string, chatId?: number): Reminder {
    const reminder: Reminder = {
      id: createId("reminder"),
      userId,
      chatId,
      text: text.trim(),
      datetime,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    const reminders = this.listReminders(userId);
    this.remindersByUser.set(userId, [...reminders, reminder]);
    return reminder;
  }

  listDueReminders(referenceTime: Date): Reminder[] {
    const dueReminders: Reminder[] = [];

    for (const reminders of this.remindersByUser.values()) {
      for (const reminder of reminders) {
        if (reminder.status !== "pending") {
          continue;
        }

        if (new Date(reminder.datetime).getTime() <= referenceTime.getTime()) {
          dueReminders.push(reminder);
        }
      }
    }

    return dueReminders;
  }

  snoozeReminder(userId: string, reminderId: string, newDatetime: string): Reminder | undefined {
    const reminders = this.listReminders(userId);
    const idx = reminders.findIndex((r) => r.id === reminderId);
    if (idx === -1) return undefined;
    const updated: Reminder = { ...reminders[idx], datetime: newDatetime, status: "pending" };
    reminders[idx] = updated;
    this.remindersByUser.set(userId, reminders);
    return updated;
  }

  deleteReminder(userId: string, reminderId: string): boolean {
    const reminders = this.listReminders(userId);
    const idx = reminders.findIndex((r) => r.id === reminderId);
    if (idx === -1) return false;
    reminders.splice(idx, 1);
    this.remindersByUser.set(userId, reminders);
    return true;
  }

  markReminderSent(reminderId: string): Reminder | undefined {
    for (const [userId, reminders] of this.remindersByUser.entries()) {
      const reminderIndex = reminders.findIndex((reminder) => reminder.id === reminderId);
      if (reminderIndex === -1) {
        continue;
      }

      const updatedReminder: Reminder = {
        ...reminders[reminderIndex],
        status: "sent"
      };
      const nextReminders = [...reminders];
      nextReminders[reminderIndex] = updatedReminder;
      this.remindersByUser.set(userId, nextReminders);
      return updatedReminder;
    }

    return undefined;
  }
}
