import test from "node:test";
import assert from "node:assert/strict";
import { parseNaturalLanguageDate } from "./time.js";

const NOW = new Date("2026-04-12T08:00:00.000Z");

test("explicit date with hour is parsed correctly", () => {
  const result = parseNaturalLanguageDate("17.6 בשעה 15", "UTC", NOW);
  assert.ok(result.startAt);
  assert.deepEqual(result.missingFields, []);
  assert.ok(result.confidence >= 0.9);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCMonth(), 5); // June = 5
  assert.equal(start.getUTCDate(), 17);
  assert.equal(start.getUTCHours(), 15);
});

test("explicit date without hour defaults to morning", () => {
  const result = parseNaturalLanguageDate("17.6", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 9);
});

test("tomorrow with explicit hour resolves correctly", () => {
  const result = parseNaturalLanguageDate("מחר בשעה 10", "UTC", NOW);
  assert.ok(result.startAt);
  assert.deepEqual(result.missingFields, []);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCDate(), 13); // April 13
  assert.equal(start.getUTCHours(), 10);
});

test("today with evening phrase resolves to 19:00", () => {
  const result = parseNaturalLanguageDate("היום בערב", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 19);
});

test("relative duration in english minutes", () => {
  const result = parseNaturalLanguageDate("in 30 minutes", "UTC", NOW);
  assert.ok(result.startAt);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.confidence, 0.95);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 8);
  assert.equal(start.getUTCMinutes(), 30);
});

test("relative duration in english hours", () => {
  const result = parseNaturalLanguageDate("in 2 hours", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 10);
});

test("hebrew duration בעוד שעה resolves to +1 hour", () => {
  const result = parseNaturalLanguageDate("בעוד שעה", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 9);
});

test("hebrew duration בעוד שעתיים resolves to +2 hours", () => {
  const result = parseNaturalLanguageDate("בעוד שעתיים", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCHours(), 10);
});

test("hebrew duration בעוד 45 דקות resolves to +45 minutes", () => {
  const result = parseNaturalLanguageDate("בעוד 45 דקות", "UTC", NOW);
  assert.ok(result.startAt);
  const start = new Date(result.startAt!);
  assert.equal(start.getUTCMinutes(), 45);
});

test("unrecognised input returns low confidence with missing startAt", () => {
  const result = parseNaturalLanguageDate("אולי פעם", "UTC", NOW);
  assert.ok(result.confidence < 0.5);
  assert.ok(result.missingFields.includes("startAt"));
});
