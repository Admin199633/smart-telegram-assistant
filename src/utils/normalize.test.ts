import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInput, matchesAny, REMINDER_TRIGGERS, MEETING_TRIGGERS, LIST_ADD_TRIGGERS, LIST_VIEW_TRIGGERS, LIST_VIEW_ALL_TRIGGERS, LIST_REMOVE_TRIGGERS, CREATE_LIST_TRIGGERS } from "./normalize.js";

// ---------------------------------------------------------------------------
// normalizeInput
// ---------------------------------------------------------------------------

test("collapses repeated whitespace", () => {
  assert.equal(normalizeInput("תזכיר  לי   מחר"), "תזכיר לי מחר");
});

test("deduplicates repeated punctuation", () => {
  assert.equal(normalizeInput("מה??"), "מה?");
  assert.equal(normalizeInput("כן!!"), "כן!");
  assert.equal(normalizeInput("רשימה.."), "רשימה.");
});

test("normalises עוד X to בעוד X at start", () => {
  assert.equal(normalizeInput("עוד 5 דקות"), "בעוד 5 דקות");
});

test("normalises עוד X to בעוד X in the middle of a sentence", () => {
  assert.equal(normalizeInput("תזכיר לי עוד שעה"), "תזכיר לי בעוד שעה");
});

test("does not double-prefix בעוד X", () => {
  assert.equal(normalizeInput("בעוד 10 דקות"), "בעוד 10 דקות");
});

test("normalises ב- with space before digit to ב-N", () => {
  assert.equal(normalizeInput("ב- 5 בערב"), "ב-5 בערב");
});

test("normalises ב with space before digit to ב-N", () => {
  assert.equal(normalizeInput("ב 5 בערב"), "ב-5 בערב");
});

test("corrects common typo רשימהת to רשימת", () => {
  assert.equal(normalizeInput("מה יש ברשימהת קניות"), "מה יש ברשימת קניות");
});

test("trims surrounding whitespace", () => {
  assert.equal(normalizeInput("  תזכיר לי  "), "תזכיר לי");
});

test("is idempotent when called twice", () => {
  const once = normalizeInput("עוד 5 דקות");
  const twice = normalizeInput(once);
  assert.equal(once, twice);
});

// ---------------------------------------------------------------------------
// Typo corrections
// ---------------------------------------------------------------------------

test("corrects ארוע to אירוע", () => {
  assert.equal(normalizeInput("תקבע לי ארוע מחר"), "תקבע לי אירוע מחר");
});

test("does not alter אירוע when already correct", () => {
  assert.equal(normalizeInput("תקבע לי אירוע מחר"), "תקבע לי אירוע מחר");
});

test("corrects תזכרת to תזכורת", () => {
  assert.equal(normalizeInput("תשלח תזכרת מחר"), "תשלח תזכורת מחר");
});

test("corrects קנייות to קניות", () => {
  assert.equal(normalizeInput("רשימת קנייות"), "רשימת קניות");
});

test("corrects תוסיפ at end of token to תוסיף", () => {
  assert.equal(normalizeInput("תוסיפ חלב"), "תוסיף חלב");
});

test("does not alter תוסיף when already correct", () => {
  assert.equal(normalizeInput("תוסיף חלב"), "תוסיף חלב");
});

// ---------------------------------------------------------------------------
// matchesAny
// ---------------------------------------------------------------------------

test("matchesAny returns true on first matching pattern", () => {
  assert.equal(matchesAny("תזכיר לי", REMINDER_TRIGGERS), true);
});

test("matchesAny returns false when no pattern matches", () => {
  assert.equal(matchesAny("שלום עולם", REMINDER_TRIGGERS), false);
});

// ---------------------------------------------------------------------------
// Phrase families
// ---------------------------------------------------------------------------

test("REMINDER_TRIGGERS matches תזכיר", () => {
  assert.equal(matchesAny("תזכיר לי מחר בבוקר", REMINDER_TRIGGERS), true);
});

test("REMINDER_TRIGGERS matches remind", () => {
  assert.equal(matchesAny("remind me tomorrow", REMINDER_TRIGGERS), true);
});

test("MEETING_TRIGGERS matches פגישה", () => {
  assert.equal(matchesAny("קבע לי פגישה מחר", MEETING_TRIGGERS), true);
});

test("MEETING_TRIGGERS matches ביומן", () => {
  assert.equal(matchesAny("תוסיף ביומן", MEETING_TRIGGERS), true);
});

test("LIST_ADD_TRIGGERS matches תוסיף", () => {
  assert.equal(matchesAny("תוסיף חלב לרשימה", LIST_ADD_TRIGGERS), true);
});

test("LIST_ADD_TRIGGERS matches קניות", () => {
  assert.equal(matchesAny("רשימת קניות", LIST_ADD_TRIGGERS), true);
});

test("LIST_VIEW_TRIGGERS matches מה יש ברשימת הקניות", () => {
  assert.equal(matchesAny("מה יש ברשימת הקניות", LIST_VIEW_TRIGGERS), true);
});

test("LIST_VIEW_TRIGGERS matches תציג לי את הרשימה", () => {
  assert.equal(matchesAny("תציג לי את הרשימה", LIST_VIEW_TRIGGERS), true);
});

test("LIST_VIEW_ALL_TRIGGERS matches אילו רשימות", () => {
  assert.equal(matchesAny("אילו רשימות יש לי", LIST_VIEW_ALL_TRIGGERS), true);
});

test("LIST_VIEW_ALL_TRIGGERS matches תציג את כל הרשימות", () => {
  assert.equal(matchesAny("תציג את כל הרשימות", LIST_VIEW_ALL_TRIGGERS), true);
});

test("LIST_REMOVE_TRIGGERS matches תסיר 1", () => {
  assert.equal(matchesAny("תסיר 1", LIST_REMOVE_TRIGGERS), true);
});

test("LIST_REMOVE_TRIGGERS matches מחק פריט 2", () => {
  assert.equal(matchesAny("מחק פריט 2", LIST_REMOVE_TRIGGERS), true);
});

test("CREATE_LIST_TRIGGERS matches תיצור לי רשימה", () => {
  assert.equal(matchesAny("תיצור לי רשימה", CREATE_LIST_TRIGGERS), true);
});

test("CREATE_LIST_TRIGGERS matches רשימה חדשה", () => {
  assert.equal(matchesAny("רשימה חדשה", CREATE_LIST_TRIGGERS), true);
});
