import assert from "node:assert/strict";
import { buildTelegramMarkup, createApp } from "./app.js";
import { parseNaturalLanguageDate } from "./utils/time.js";

async function main(): Promise<void> {
  await testComposeIntent();
  await testComposeIntentCleansPromptText();
  await testComposeReturnsVariants();
  await testComposeRewriteUsesProvidedDraft();
  await testMeetingIntent();
  await testRelativeMeetingIntent();
  await testFuzzyMeetingTime();
  await testRelativeMeetingUsesQuotedTitle();
  await testClarifyIntentDoesNotExposeAction();
  await testUnknownAppAction();
  await testGoogleOauthRedirect();
  await testGoogleOauthStartJsonMode();
  console.log("All tests passed");
}

async function testComposeIntent(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u1",
        text: "תנסח לי הודעה מקצועית על דחיית פגישה"
      })
    });
    const body = await response.json() as {
      intent: string;
      proposedAction?: {
        type: string;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.intent, "compose_message");
    assert.equal(body.proposedAction?.type, "compose_message");
  } finally {
    server.close();
  }
}

async function testComposeIntentCleansPromptText(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u1-clean",
        text: "תנסח לי הודעה אישית לאמיר שאני מאחר ב-20 דקות"
      })
    });
    const body = await response.json() as {
      draftResponse: string;
    };

    assert.equal(response.status, 200);
    assert.ok(body.draftResponse.length > 0);
    assert.ok(!body.draftResponse.includes("לי הודעה אישית"));
  } finally {
    server.close();
  }
}

async function testComposeReturnsVariants(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u-variants",
        text: "תנסח לי הודעה קצרה לאמיר שאני מאחר ב-20 דקות"
      })
    });
    const body = await response.json() as {
      draftResponse: string;
      proposedAction?: {
        payload?: {
          variants?: Array<{ label: string; content: string }>;
        };
      };
    };

    assert.equal(response.status, 200);
    assert.ok(body.draftResponse.includes("קצר:"));
    assert.ok(body.draftResponse.includes("מקצועי:"));
    assert.ok(body.proposedAction?.payload?.variants?.length === 3);
  } finally {
    server.close();
  }
}

async function testComposeRewriteUsesProvidedDraft(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u1-rewrite",
        text: "תנסח לי הודעה קצרה לבוסית שלי\n\nהי דורלי אני מצטער אבל אני חולה אני לא אגיע היום"
      })
    });
    const body = await response.json() as {
      draftResponse: string;
    };

    assert.equal(response.status, 200);
    assert.ok(body.draftResponse.length > 0);
    assert.ok(!body.draftResponse.includes("אשמח לתאם בנושא"));
  } finally {
    server.close();
  }
}

async function testMeetingIntent(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u2",
        text: "פגישה ב17.6 בשעה 5 עם חיים"
      })
    });
    const body = await response.json() as {
      intent: string;
      proposedAction?: {
        type: string;
        payload?: {
          startAt?: string;
        };
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.intent, "schedule_meeting");
    assert.equal(body.proposedAction?.type, "schedule_meeting");
    assert.ok(body.proposedAction?.payload?.startAt);
  } finally {
    server.close();
  }
}

async function testRelativeMeetingIntent(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u-relative",
        text: "תקבע לי ביומן למחר בשעה 7 בערב לא לשכוח לתלות כביסה"
      })
    });
    const body = await response.json() as {
      intent: string;
      proposedAction?: {
        payload?: {
          startAt?: string;
        };
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.intent, "schedule_meeting");
    assert.ok(body.proposedAction?.payload?.startAt);
  } finally {
    server.close();
  }
}

async function testFuzzyMeetingTime(): Promise<void> {
  const result = parseNaturalLanguageDate(
    "\u05e7\u05d1\u05e2 \u05dc\u05d9 \u05d1\u05d9\u05d5\u05de\u05df \u05de\u05d7\u05e8 \u05d1\u05e2\u05e8\u05d1",
    "UTC",
    new Date("2026-04-12T08:00:00.000Z")
  );

  assert.deepEqual(result.missingFields, []);
  assert.ok(result.startAt);
  assert.ok(result.endAt);
  assert.equal(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(result.startAt)),
    "19:00"
  );
}

async function testRelativeMeetingUsesQuotedTitle(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/agent/interpret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userId: "u-relative-title",
        text: "תקבע לי ביומן למחר בשעה 7 בערב ״לא לשכוח לתלות כביסה״"
      })
    });
    const body = await response.json() as {
      proposedAction?: {
        payload?: {
          title?: string;
        };
      };
      draftResponse: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.proposedAction?.payload?.title, "לא לשכוח לתלות כביסה");
    assert.ok(body.draftResponse.includes("לא לשכוח לתלות כביסה"));
  } finally {
    server.close();
  }
}

async function testClarifyIntentDoesNotExposeAction(): Promise<void> {
  const { services } = createApp();
  const interpretation = await services.orchestrator.interpret("u-clarify", "תקבע לי ביומן מתישהו מחר");

  assert.equal(interpretation.intent, "clarify");
  assert.ok(interpretation.proposedAction?.missingFields?.includes("startAt"));
  const markup = buildTelegramMarkup({
    interpretation,
    userId: "u-clarify",
    chatId: 1,
    hasGoogleCalendarAuth: false,
    publicBaseUrl: "https://example.com"
  });
  assert.equal(markup, undefined);
}

async function testUnknownAppAction(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/integrations/apps/unknown/do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: {}
      })
    });

    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
}

async function testGoogleOauthRedirect(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/oauth/google/start?userId=u3&chatId=123`, {
      redirect: "manual"
    });

    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(location?.includes("accounts.google.com"));
    assert.ok(location?.includes("state="));
  } finally {
    server.close();
  }
}

async function testGoogleOauthStartJsonMode(): Promise<void> {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/oauth/google/start?userId=u3&chatId=123&mode=json`);
    const body = await response.json() as { authorizationUrl: string };

    assert.equal(response.status, 200);
    assert.ok(body.authorizationUrl.includes("accounts.google.com"));
    assert.ok(body.authorizationUrl.includes("state="));
  } finally {
    server.close();
  }
}

function getPort(server: ReturnType<typeof createApp>["app"] extends infer _ ? import("node:http").Server : never): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not start");
  }
  return address.port;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
