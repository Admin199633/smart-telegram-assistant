import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

test("agent interpret returns compose action for generic text", async () => {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not start");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/agent/interpret`, {
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
});

test("meeting request returns confirmable calendar action", async () => {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not start");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/agent/interpret`, {
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
});

test("list item strip: 'תוסיף טונה' should not save raw command as item", async () => {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not start");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/agent/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u3", text: "תוסיף טונה" })
    });
    const body = await response.json() as {
      proposedAction?: { payload?: { items?: string[] } };
    };

    const items = body.proposedAction?.payload?.items ?? [];
    assert.ok(!items.includes("תוסיף טונה"), "raw command should not be saved as item");
    assert.ok(items.includes("טונה"), "extracted item 'טונה' should be present");
  } finally {
    server.close();
  }
});

test("list item strip: 'שים ברשימת סופר עגבניות' should save only 'עגבניות'", async () => {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not start");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/agent/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u4", text: "שים ברשימת סופר עגבניות" })
    });
    const body = await response.json() as {
      proposedAction?: { payload?: { items?: string[] } };
    };

    const items = body.proposedAction?.payload?.items ?? [];
    assert.deepEqual(items, ["עגבניות"]);
  } finally {
    server.close();
  }
});

test("unknown app action returns 404", async () => {
  const { app } = createApp();
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not start");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/integrations/apps/unknown/do`, {
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
});
