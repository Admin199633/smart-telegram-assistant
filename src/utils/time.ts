const MORNING_HOUR = 9;
const AFTERNOON_HOUR = 13;
const EVENING_HOUR = 19;
const DEFAULT_DURATION_MINUTES = 60;

const HEBREW_AT_PATTERN = "(?:\\u05d1\\u05e9\\u05e2\\u05d4|\\u05d1|at)";
const HEBREW_TOMORROW_PATTERN = "\\u05de\\u05d7\\u05e8";
const HEBREW_TODAY_PATTERN = "\\u05d4\\u05d9\\u05d5\\u05dd";
const HEBREW_FRIDAY_PATTERN = "\\u05e9\\u05d9\\u05e9\\u05d9";
const HEBREW_MORNING_PATTERN = "(?:\\u05d1\\u05d1\\u05d5\\u05e7\\u05e8|\\u05d1\\u05d5\\u05e7\\u05e8)";
const HEBREW_AFTERNOON_PATTERN = "(?:\\u05d1\\u05e6\\u05d4\\u05e8\\u05d9\\u05d9\\u05dd|\\u05e6\\u05d4\\u05e8\\u05d9\\u05d9\\u05dd)";
const HEBREW_EVENING_PATTERN = "(?:\\u05d1\\u05e2\\u05e8\\u05d1|\\u05e2\\u05e8\\u05d1)";

export interface ParsedTimeResult {
  startAt?: string;
  endAt?: string;
  inferredTimeText?: string;
  confidence: number;
  missingFields: string[];
}

// Ordered so longer/more-specific phrases are replaced before shorter ones that share substrings.
const HEBREW_WORD_TIME_SUBS: Array<[string, string]> = [
  ["חצי שעה", "30 דקות"],
  ["רבע שעה", "15 דקות"],
  ["עשרים דקות", "20 דקות"],
  ["חמש עשרה דקות", "15 דקות"],
  ["עשר דקות", "10 דקות"],
  ["תשע דקות", "9 דקות"],
  ["שמונה דקות", "8 דקות"],
  ["שבע דקות", "7 דקות"],
  ["שש דקות", "6 דקות"],
  ["חמש דקות", "5 דקות"],
  ["ארבע דקות", "4 דקות"],
  ["שלוש דקות", "3 דקות"],
  ["שתי דקות", "2 דקות"],
  ["דקה", "1 דקות"]
];

// Applied AFTER duration subs so "בחמש דקות" becomes "ב5 דקות" not "ב5 שעות".
// Longer phrases first to avoid "בשתים" matching inside "בשתים עשרה".
const HEBREW_HOUR_AT_SUBS: Array<[string, string]> = [
  ["בשתים עשרה", "ב12"],
  ["באחת עשרה", "ב11"],
  ["בעשר", "ב10"],
  ["בתשע", "ב9"],
  ["בשמונה", "ב8"],
  ["בשבע", "ב7"],
  ["בשש", "ב6"],
  ["בחמש", "ב5"],
  ["בארבע", "ב4"],
  ["בשלוש", "ב3"],
  ["בשתיים", "ב2"],
  ["באחת", "ב1"]
];

function normalizeHebrewWordTime(input: string): string {
  let result = input;
  // "עוד X" → "בעוד X" so relative durations are recognised in direct parsing too
  result = result.replace(/(^|\s)עוד\s+/g, "$1בעוד ");
  // Strip dash between ב-prefix and digit: "ב-5" → "ב5"
  result = result.replace(/ב-(\d)/g, "ב$1");
  for (const [from, to] of HEBREW_WORD_TIME_SUBS) {
    if (result.includes(from)) {
      result = result.split(from).join(to);
    }
  }
  for (const [from, to] of HEBREW_HOUR_AT_SUBS) {
    if (result.includes(from)) {
      result = result.split(from).join(to);
    }
  }
  return result;
}

export function parseNaturalLanguageDate(input: string, timezone: string, now = new Date()): ParsedTimeResult {
  const normalized = normalizeHebrewWordTime(input.trim());

  const duration = parseRelativeDuration(normalized, now);
  if (duration) {
    return duration;
  }

  const explicit = parseExplicitDate(normalized, timezone, now);
  if (explicit) {
    return explicit;
  }

  const relative = parseRelativeDate(normalized, now);
  if (relative) {
    return relative;
  }

  return {
    confidence: 0.2,
    inferredTimeText: normalized,
    missingFields: ["startAt"]
  };
}

// Matches: "in 30 minutes", "in 2 hours", "בעוד 30 דקות", "בעוד שעה", "בעוד שעתיים"
const HEBREW_IN_PATTERN = "בעוד";
const HEBREW_MINUTES_PATTERN = "(?:דקות|דקה)";
const HEBREW_HOURS_PATTERN = "(?:שעות|שעה|שעתיים)";

function parseRelativeDuration(input: string, now: Date): ParsedTimeResult | undefined {
  // English: "in X minutes" / "in X hours"
  const englishMatch = input.match(/\bin\s+(\d+)\s+(minute|minutes|hour|hours)\b/i);
  if (englishMatch) {
    const amount = Number(englishMatch[1]);
    const unit = englishMatch[2].toLowerCase();
    const offsetMs = unit.startsWith("hour") ? amount * 3600000 : amount * 60000;
    const start = new Date(now.getTime() + offsetMs);
    return {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(),
      inferredTimeText: input,
      confidence: 0.95,
      missingFields: []
    };
  }

  // Hebrew: "בעוד X דקות" / "בעוד X שעות" / "בעוד שעה" / "בעוד שעתיים"
  const hebrewHoursFixed = new RegExp(`${HEBREW_IN_PATTERN}\\s+שעתיים`);
  if (hebrewHoursFixed.test(input)) {
    const start = new Date(now.getTime() + 2 * 3600000);
    return {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(),
      inferredTimeText: input,
      confidence: 0.95,
      missingFields: []
    };
  }

  const hebrewSingleHour = new RegExp(`${HEBREW_IN_PATTERN}\\s+שעה(?:\\s|$)`);
  if (hebrewSingleHour.test(input)) {
    const start = new Date(now.getTime() + 3600000);
    return {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(),
      inferredTimeText: input,
      confidence: 0.95,
      missingFields: []
    };
  }

  const hebrewNumericMatch = input.match(new RegExp(`${HEBREW_IN_PATTERN}\\s+(\\d+)\\s+(?:${HEBREW_MINUTES_PATTERN}|${HEBREW_HOURS_PATTERN})`));
  if (hebrewNumericMatch) {
    const amount = Number(hebrewNumericMatch[1]);
    const isHours = new RegExp(HEBREW_HOURS_PATTERN).test(input.slice(input.indexOf(hebrewNumericMatch[1]) + hebrewNumericMatch[1].length));
    const offsetMs = isHours ? amount * 3600000 : amount * 60000;
    const start = new Date(now.getTime() + offsetMs);
    return {
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(),
      inferredTimeText: input,
      confidence: 0.95,
      missingFields: []
    };
  }

  // Hebrew day/week durations: "בעוד יומיים", "בעוד שבוע", "בעוד X ימים", "בעוד X שבועות"
  if (/בעוד\s+יומיים/.test(input)) {
    const start = new Date(now.getTime() + 2 * 24 * 3600000);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(), inferredTimeText: input, confidence: 0.95, missingFields: [] };
  }
  if (/בעוד\s+שבוע/.test(input)) {
    const start = new Date(now.getTime() + 7 * 24 * 3600000);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(), inferredTimeText: input, confidence: 0.95, missingFields: [] };
  }
  const hebrewDaysMatch = input.match(/בעוד\s+(\d+)\s+ימים/);
  if (hebrewDaysMatch) {
    const start = new Date(now.getTime() + Number(hebrewDaysMatch[1]) * 24 * 3600000);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(), inferredTimeText: input, confidence: 0.95, missingFields: [] };
  }
  const hebrewWeeksMatch = input.match(/בעוד\s+(\d+)\s+שבועות/);
  if (hebrewWeeksMatch) {
    const start = new Date(now.getTime() + Number(hebrewWeeksMatch[1]) * 7 * 24 * 3600000);
    return { startAt: start.toISOString(), endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(), inferredTimeText: input, confidence: 0.95, missingFields: [] };
  }

  return undefined;
}

function parseExplicitDate(input: string, timezone: string, now: Date): ParsedTimeResult | undefined {
  const match = input.match(new RegExp(`(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?(?:\\s*${HEBREW_AT_PATTERN}\\s*(\\d{1,2})(?::(\\d{2}))?)?`, "i"));
  if (!match) {
    return undefined;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return undefined;
  }

  const parsedYear = match[3] ? Number(match[3]) : now.getFullYear();
  const year = parsedYear < 100 ? 2000 + parsedYear : parsedYear;
  const hour = match[4] ? Number(match[4]) : MORNING_HOUR;
  const minute = match[5] ? Number(match[5]) : 0;

  const start = zonedToUtc(year, month - 1, day, hour, minute, timezone);

  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString(),
    inferredTimeText: input,
    confidence: match[4] ? 0.95 : 0.75,
    missingFields: []
  };
}

function zonedToUtc(year: number, month0: number, day: number, hour: number, minute: number, timezone: string): Date {
  const rough = new Date(Date.UTC(year, month0, day, hour, minute));
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = fmt.formatToParts(rough);
    const tzHour = Number(parts.find((p) => p.type === "hour")?.value ?? hour);
    const tzMinute = Number(parts.find((p) => p.type === "minute")?.value ?? minute);

    let diffMs = ((hour - tzHour) * 60 + (minute - tzMinute)) * 60000;
    if (diffMs > 12 * 3600000) diffMs -= 24 * 3600000;
    if (diffMs < -12 * 3600000) diffMs += 24 * 3600000;

    return new Date(rough.getTime() + diffMs);
  } catch {
    return rough;
  }
}

function parseRelativeDate(input: string, now: Date): ParsedTimeResult | undefined {
  const baseDate = resolveRelativeBaseDate(input, now);
  const hourMatch = input.match(new RegExp(`${HEBREW_AT_PATTERN}\\s*(\\d{1,2})(?::(\\d{2}))?`, "i"));
  const amPm = parseAmPmTime(input);
  const fuzzyHour = resolveFuzzyHour(input);

  // Standalone digit + fuzzy period: "5 בצהריים" → today/tomorrow at 17:00
  const standaloneHour = (!hourMatch && !amPm && fuzzyHour !== undefined)
    ? input.match(/(?:^|\s)(\d{1,2})(?:\s|$)/)
    : null;

  if (!baseDate && !hourMatch && !amPm && !standaloneHour && fuzzyHour === undefined) {
    return undefined;
  }

  const start = new Date(baseDate ?? now);
  let hour: number | undefined;
  let minute = 0;

  if (amPm) {
    hour = amPm.hour;
    minute = amPm.minute;
  } else if (hourMatch) {
    hour = Number(hourMatch[1]);
    minute = hourMatch[2] ? Number(hourMatch[2]) : 0;
    if (fuzzyHour === EVENING_HOUR && hour < 12) {
      hour += 12;
    }
    if (fuzzyHour === MORNING_HOUR && hour === 12) {
      hour = 0;
    }
  } else if (standaloneHour && fuzzyHour !== undefined) {
    hour = Number(standaloneHour[1]);
    if ((fuzzyHour === AFTERNOON_HOUR || fuzzyHour === EVENING_HOUR) && hour < 12) {
      hour += 12;
    }
    if (fuzzyHour === MORNING_HOUR && hour === 12) {
      hour = 0;
    }
  } else if (fuzzyHour !== undefined) {
    hour = fuzzyHour;
  }

  if (hour !== undefined) {
    start.setHours(hour, minute, 0, 0);
    if (fuzzyHour !== undefined && start.getTime() <= now.getTime()) {
      start.setDate(start.getDate() + 1);
    }
  }

  return {
    startAt: hour !== undefined ? start.toISOString() : undefined,
    endAt: hour !== undefined ? new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000).toISOString() : undefined,
    inferredTimeText: input,
    confidence: hour !== undefined ? (hourMatch || amPm ? 0.9 : 0.82) : 0.45,
    missingFields: hour !== undefined ? [] : ["startAt"]
  };
}

function parseAmPmTime(input: string): { hour: number; minute: number } | undefined {
  const match = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) {
    return undefined;
  }

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const period = match[3].toLowerCase();

  if (period === "am") {
    if (hour === 12) {
      hour = 0;
    }
  } else {
    if (hour !== 12) {
      hour += 12;
    }
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return { hour, minute };
}

function resolveRelativeBaseDate(input: string, now: Date): Date | undefined {
  if (new RegExp(`${HEBREW_TOMORROW_PATTERN}|tomorrow`, "i").test(input)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  if (new RegExp(`${HEBREW_TODAY_PATTERN}|today`, "i").test(input)) {
    return new Date(now);
  }

  if (new RegExp(`${HEBREW_FRIDAY_PATTERN}|friday`, "i").test(input)) {
    return nextWeekday(now, 5);
  }

  return undefined;
}

function resolveFuzzyHour(input: string): number | undefined {
  if (new RegExp(`${HEBREW_MORNING_PATTERN}|morning`, "i").test(input)) {
    return MORNING_HOUR;
  }

  if (new RegExp(`${HEBREW_AFTERNOON_PATTERN}|afternoon`, "i").test(input)) {
    return AFTERNOON_HOUR;
  }

  if (new RegExp(`${HEBREW_EVENING_PATTERN}|evening|tonight`, "i").test(input)) {
    return EVENING_HOUR;
  }

  return undefined;
}

function nextWeekday(now: Date, weekday: number): Date {
  const result = new Date(now);
  const distance = (weekday - now.getDay() + 7) % 7 || 7;
  result.setDate(now.getDate() + distance);
  return result;
}

export function formatDateTime(isoDate?: string, locale = "he-IL", timezone = "Asia/Jerusalem"): string {
  if (!isoDate) {
    return "\u05dc\u05d0 \u05d4\u05d5\u05d2\u05d3\u05e8";
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone
  }).format(new Date(isoDate));
}
