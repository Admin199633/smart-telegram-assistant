/**
 * Shared input normalization applied before intent detection.
 * Keeps normalization light — only canonical surface-form cleanup.
 * Deeper time-expression substitutions live in time.ts.
 */

export function normalizeInput(text: string): string {
  return text
    .trim()
    // collapse repeated whitespace
    .replace(/\s+/g, " ")
    // deduplicate repeated punctuation (??, !!, ..)
    .replace(/([?!.،,])\1+/g, "$1")
    // "עוד X" → "בעוד X" so duration phrases are uniformly prefixed
    .replace(/(^|\s)עוד\s+/g, "$1בעוד ")
    // "ב X" / "ב- X" → "ב-X" so date/time references are uniform
    .replace(/ב-?\s+(\d)/g, "ב-$1")
    // ── Typo corrections for high-frequency bot keywords ──────────────────────
    // list: "רשימהת" → "רשימת"
    .replace(/רשימהת/gi, "רשימת")
    // event: "ארוע" → "אירוע" (missing yod — very common misspelling)
    .replace(/(?<![א-ת])ארוע(?![א-ת])/g, "אירוע")
    // reminder noun: "תזכרת" → "תזכורת" (missing vav)
    .replace(/תזכרת/g, "תזכורת")
    // shopping: "קנייות" → "קניות" (double yod)
    .replace(/קנייות/g, "קניות")
    // add verb: "תוסיפ" → "תוסיף" (missing final-pe dagesh at end-of-token)
    .replace(/תוסיפ(?=\s|$)/g, "תוסיף")
    .trim();
}

/** Returns true if the text matches any pattern in the family. */
export function matchesAny(text: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Phrase families — centralised so all intent-detection helpers share one place
// ---------------------------------------------------------------------------

export const REMINDER_TRIGGERS: ReadonlyArray<RegExp> = [
  /תזכיר|תזכור|remind|reminder|להזכיר/i
];

/** Snooze/postpone-reminder phrases */
export const REMINDER_SNOOZE_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:דחה|דחי|לדחות|תדחה|תדחי)\s+(?:את\s+)?(?:ה)?תזכורת/i,
  /(?:הזז|תזיז)\s+(?:את\s+)?(?:ה)?תזכורת/i,
  /(?:snooze|נודניק)\s+(?:תזכורת\s+)?\d*/i,
  /(?:תזכיר|תזכור)\s+(?:לי\s+)?(?:שוב|מאוחר יותר|יותר מאוחר)/i
];

/** Delete-reminder phrases */
export const REMINDER_DELETE_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:מחק|הסר|בטל|תמחק|תסיר|תבטל)\s+(?:את\s+)?(?:ה)?תזכורת/i,
  /(?:מחק|הסר|בטל|תמחק|תסיר|תבטל)\s+(?:תזכורת|reminder)\s+(?:מספר\s+)?\d+/i
];

/** View-reminders phrases — checked BEFORE REMINDER_TRIGGERS to avoid routing as create */
export const REMINDER_VIEW_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:מה|תציג|הצג|תראה|הראה)\s+(?:לי\s+)?(?:את\s+)?(?:ה)?תזכורות/i,
  /(?:אילו|איזה|כמה|מה)\s+תזכורות\s+(?:יש\s+לי|קיימות|שלי)/i,
  /תזכורות\s+(?:שלי|פעילות|קיימות)/i,
  /(?:הצג|תציג)\s+(?:לי\s+)?תזכורות/i
];

export const MEETING_TRIGGERS: ReadonlyArray<RegExp> = [
  // meeting / event nouns — absolute and construct forms (פגישת, ישיבת, ועידת)
  /פגישה|פגישת|מפגש|ישיבה|ישיבת|ועידה|ועידת/i,
  // appointment
  /\bתור\b/i,
  // scheduling verbs (without calendar noun — avoids "מה יש לי ביומן")
  /לקבוע|תקבע|קבע|לזמן|תזמן/i,
  // explicit creation with calendar noun
  /(?:תרשום|רשום|הוסף|תוסיף|תכניס|כנס)\s+(?:לי\s+)?(?:ב|ל)יומן/i,
  /(?:תיצור|צור|ליצור|תצור)\s+(?:לי\s+)?אירוע/i,
  /(?:אירוע|meeting)\s+(?:חדש|ביומן)/i,
  // English keyword
  /\bmeeting\b/i,
  // bare calendar noun kept for backwards compat — view-trigger guard in looksLikeMeetingRequest takes priority
  /ביומן|ליומן|יומן/i
];

/** Calendar view phrases — checked BEFORE MEETING_TRIGGERS so "מה יש לי ביומן" isn't treated as create */
export const CALENDAR_VIEW_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:מה|תציג|הצג|תראה|הראה)\s+(?:לי\s+)?(?:את\s+)?ה?יומן/i,
  /מה\s+(?:יש\s+לי|קבוע\s+לי)\s+(?:היום|מחר|השבוע|הלילה)/i,
  /אירועים?\s+(?:היום|מחר|השבוע)/i,
  /מה\s+קבוע\s+לי/i,
  /(?:הצג|תציג)\s+(?:לי\s+)?(?:את\s+)?(?:ה)?אירועים/i
];

/** Calendar update phrases */
export const CALENDAR_UPDATE_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:שנה|עדכן|דחה|הזז)\s+(?:את\s+)?ה?(?:פגישה|פגישת|אירוע|תור|מפגש|ישיבה|ישיבת)/i,
  /(?:שנה|עדכן)\s+(?:שעה|תאריך|יום)/i
];

/** Calendar delete phrases */
export const CALENDAR_DELETE_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:בטל|מחק|הסר)\s+(?:את\s+)?ה?(?:פגישה|פגישת|אירוע|תור|מפגש|ישיבה|ישיבת)/i,
  /(?:הסר|מחק)\s+(?:מהיומן|מיומן)/i
];

export const COMPOSE_TRIGGERS: ReadonlyArray<RegExp> = [
  /^(?:תכתוב|תכתבי|נסח|נסחי|תנסח|תנסחי)/u,
  /(?:הודעה|מייל)/u
];

export const LIST_ADD_TRIGGERS: ReadonlyArray<RegExp> = [
  /רשימת\s+קניות|קניות|תוסיף|תוסיפי|תכניס/i,
  // "שים" as a standalone word (avoid matching mid-word)
  /(?:^|\s)שים(?:\s|$)/
];

export const LIST_VIEW_TRIGGERS: ReadonlyArray<RegExp> = [
  // "תציג לי את רשימת סופר" / "מה רשימת הקניות" — any named list
  /(?:מה|תציג|הצג|תראה|ראה|הראה)\s+(?:לי\s+)?(?:את\s+)?(?:ה?רשימת\s+ה?[\u0590-\u05FF]+|הרשימה)/i,
  // "תציג לי את קניות" — view verb + את + bare list name (no רשימת prefix)
  /(?:תציג|תציגי|הצג|הציגי|תראה|תראי|הראה|הראי|תפתח|תפתחי|פתח|פתחי)\s+(?:לי\s+)?את\s+ה?[\u0590-\u05FF]+/i,
  // "רשימת X שלי"
  /רשימת\s+ה?[\u0590-\u05FF]+\s+שלי/i,
  // "מה יש ברשימת X"
  /מה\s+יש\s+ב(?:ה?רשימת\s+ה?[\u0590-\u05FF]+|הרשימה)/i
];

export const LIST_VIEW_ALL_TRIGGERS: ReadonlyArray<RegExp> = [
  // question-word led — accept both plural "רשימות" and singular "רשימה"
  /(?:איזה|אילו|כמה|מה)\s+(?:כל\s+)?ה?רשימ(?:ות|ה)/i,
  // noun led
  /ה?רשימ(?:ות|ה)\s+(?:יש|קיימות|שלי)/i,
  // verb led — require plural "רשימות" OR explicit "כל" so singular "הרשימה" routes to VIEW_LIST instead
  /(?:תציג|תראה|הצג|הראה)\s+(?:לי\s+)?(?:את\s+)?(?:כל\s+ה?רשימ(?:ות|ה)|ה?רשימות)/i
];

export const LIST_REMOVE_TRIGGERS: ReadonlyArray<RegExp> = [
  /^(?:תסיר|תמחק|מחק|הסר|תוריד|הוריד)(?:\s+מרשימת\s+ה?קניות)?\s+(?:(?:את|פריט|מספר)\s+)?\d+/i
];

export const APP_ACTION_TRIGGERS: ReadonlyArray<RegExp> = [
  /crm|ליד|lead|runbook|trigger|אפליקציה/i
];

/** Create-list phrases — "תיצור רשימת X" / "רשימה חדשה" */
export const CREATE_LIST_TRIGGERS: ReadonlyArray<RegExp> = [
  /(?:תיצור|צור|תפתח|פתח|ליצור|לפתוח)\s+(?:לי\s+)?(?:רשימה|רשימת)/i,
  /רשימה\s+(?:חדשה|נוספת|אחרת)/i
];

/** Delete-list phrases */
export const DELETE_LIST_TRIGGERS: ReadonlyArray<RegExp> = [
  // direct verb: "מחק/תמחק/הסר/תסיר/בטל/תבטל/תוריד [לי] [את] רשימת X"
  /(?:מחק|תמחק|למחוק|הסר|תסיר|להסיר|בטל|תבטל|לבטל|תוריד|להוריד|delete|remove)\s+(?:לי\s+)?(?:את\s+)?ה?רשימת\s+[\u0590-\u05FF]+/iu,
  // participial: "רוצה/אפשר + infinitive + [לי] [את] רשימת X"
  /(?:רוצה|אפשר)\s+(?:לי\s+)?(?:למחוק|להסיר|לבטל|להוריד)\s+(?:לי\s+)?(?:את\s+)?ה?רשימת\s+[\u0590-\u05FF]+/iu,
  // "לא צריך/צריכה יותר את רשימת X"
  /לא\s+צריכ[הא]?\s+(?:יותר\s+)?(?:את\s+)?ה?רשימת\s+[\u0590-\u05FF]+/iu,
  // missing name: "מחק רשימה", "תמחק לי רשימה"
  /(?:מחק|תמחק|למחוק|הסר|תסיר|להסיר|בטל|תבטל|לבטל|תוריד|להוריד|delete|remove)\s+(?:לי\s+)?(?:את\s+)?ה?רשימה(?:\s|$)/iu,
  // participial missing name: "אני רוצה למחוק רשימה"
  /(?:רוצה|אפשר)\s+(?:לי\s+)?(?:למחוק|להסיר|לבטל|להוריד)\s+(?:לי\s+)?(?:את\s+)?ה?רשימה(?:\s|$)/iu
];

/** Delete-list bare commands — verb + optional לי/את + bare Hebrew word (no "רשימה").
 *  Only routed to DELETE_LIST when the name matches an existing list (checked in orchestrator). */
export const DELETE_LIST_BARE_TRIGGERS: ReadonlyArray<RegExp> = [
  /^(?:מחק|תמחק|הסר|תסיר|תוריד)\s+(?:לי\s+)?(?:את\s+)?ה?[\u0590-\u05FF]+$/iu
];
