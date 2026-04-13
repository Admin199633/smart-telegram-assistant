import test from "node:test";
import assert from "node:assert/strict";
import { ReminderService } from "./reminder-service.js";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString(); // +1 hour
const PAST = new Date(Date.now() - 3_600_000).toISOString();   // -1 hour

test("createReminder stores a pending reminder", () => {
  const svc = new ReminderService();
  const r = svc.createReminder("u1", "call mom", FUTURE);
  assert.equal(r.status, "pending");
  assert.equal(r.text, "call mom");
  assert.equal(svc.listReminders("u1").length, 1);
});

test("listReminders returns empty array for unknown user", () => {
  const svc = new ReminderService();
  assert.deepEqual(svc.listReminders("nobody"), []);
});

test("listDueReminders returns only past pending reminders", () => {
  const svc = new ReminderService();
  svc.createReminder("u1", "past", PAST);
  svc.createReminder("u1", "future", FUTURE);
  const due = svc.listDueReminders(new Date());
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "past");
});

test("markReminderSent updates status to sent", () => {
  const svc = new ReminderService();
  const r = svc.createReminder("u1", "test", FUTURE);
  svc.markReminderSent(r.id);
  const updated = svc.getReminder("u1", r.id);
  assert.equal(updated?.status, "sent");
});

test("sent reminders are not returned by listDueReminders", () => {
  const svc = new ReminderService();
  const r = svc.createReminder("u1", "test", PAST);
  svc.markReminderSent(r.id);
  assert.equal(svc.listDueReminders(new Date()).length, 0);
});

test("deleteReminder removes the reminder", () => {
  const svc = new ReminderService();
  const r = svc.createReminder("u1", "to delete", FUTURE);
  const deleted = svc.deleteReminder("u1", r.id);
  assert.equal(deleted, true);
  assert.equal(svc.listReminders("u1").length, 0);
});

test("deleteReminder returns false for unknown id", () => {
  const svc = new ReminderService();
  assert.equal(svc.deleteReminder("u1", "nope"), false);
});

test("snoozeReminder updates datetime and resets to pending", () => {
  const svc = new ReminderService();
  const r = svc.createReminder("u1", "snooze me", PAST);
  svc.markReminderSent(r.id);
  const newTime = new Date(Date.now() + 7_200_000).toISOString();
  const updated = svc.snoozeReminder("u1", r.id, newTime);
  assert.ok(updated);
  assert.equal(updated!.status, "pending");
  assert.equal(updated!.datetime, newTime);
});

test("snoozeReminder returns undefined for unknown id", () => {
  const svc = new ReminderService();
  const result = svc.snoozeReminder("u1", "nope", FUTURE);
  assert.equal(result, undefined);
});
