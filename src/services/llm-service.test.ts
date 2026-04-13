import test from "node:test";
import assert from "node:assert/strict";
import { stripListCommandPrefix } from "./llm-service.js";

// ---------------------------------------------------------------------------
// stripListCommandPrefix — infinitive verbs inside the item must be preserved
// ---------------------------------------------------------------------------

test("strips verb + named list, keeps infinitive verb in item: לשלוח", () => {
  assert.equal(
    stripListCommandPrefix("תוסיף לרשימת עבודה לשלוח מייל לדן"),
    "לשלוח מייל לדן"
  );
});

test("strips verb + named list, keeps infinitive verb in item: לקנות", () => {
  assert.equal(
    stripListCommandPrefix("תוסיף לרשימת עבודה לקנות חלב"),
    "לקנות חלב"
  );
});

test("strips verb + named list, keeps infinitive verb in item: להזמין", () => {
  assert.equal(
    stripListCommandPrefix("תוסיף לרשימת עבודה להזמין כרטיסים"),
    "להזמין כרטיסים"
  );
});

// ---------------------------------------------------------------------------
// Regression: existing working patterns must not break
// ---------------------------------------------------------------------------

test("strips bare verb with plain item: תוסיף חלב", () => {
  assert.equal(stripListCommandPrefix("תוסיף חלב"), "חלב");
});

test("strips verb + ל<name> shorthand: תוסיף לקניות חלב", () => {
  assert.equal(stripListCommandPrefix("תוסיף לקניות חלב"), "חלב");
});

test("strips verb + לרשימת + name: תוסיף לרשימת קניות חלב", () => {
  assert.equal(stripListCommandPrefix("תוסיף לרשימת קניות חלב"), "חלב");
});

test("strips verb + ברשימת + name: שים ברשימת סופר עגבניות", () => {
  assert.equal(stripListCommandPrefix("שים ברשימת סופר עגבניות"), "עגבניות");
});

test("strips bare לרשימת X: prefix: לרשימת קניות: חלב", () => {
  assert.equal(stripListCommandPrefix("לרשימת קניות: חלב"), "חלב");
});

test("strips bare לX: colon shorthand: לקניות: חלב", () => {
  assert.equal(stripListCommandPrefix("לקניות: חלב"), "חלב");
});

test("strips bare קניות at start", () => {
  assert.equal(stripListCommandPrefix("קניות חלב"), "חלב");
});

test("plain item with no prefix is unchanged", () => {
  assert.equal(stripListCommandPrefix("חלב"), "חלב");
});
