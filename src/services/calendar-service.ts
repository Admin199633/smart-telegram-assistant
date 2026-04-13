import { config } from "../config.js";
import { CalendarRequest, GoogleTokens } from "../types.js";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export class CalendarService {
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: config.googleClientId ?? "",
      redirect_uri: config.googleRedirectUri,
      response_type: "code",
      access_type: "offline",
      scope: "https://www.googleapis.com/auth/calendar.events",
      prompt: "consent",
      state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error("Google OAuth credentials are not configured");
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUri,
        grant_type: "authorization_code"
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google token exchange failed: ${response.status} ${body}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiryDate: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
      tokenType: data.token_type
    };
  }

  async createEvent(request: CalendarRequest, accessToken?: string): Promise<Record<string, unknown>> {
    if (!accessToken) {
      return {
        status: "skipped",
        reason: "Missing Google access token",
        request
      };
    }

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        summary: request.title,
        description: request.notes,
        start: {
          dateTime: request.startAt
        },
        end: {
          dateTime: request.endAt
        },
        attendees: request.participants.filter(isValidEmail).map((email) => ({ email }))
      })
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Google Calendar error: ${response.status} ${body}`);
      (error as Error & { calendarFailure: boolean; googleAuthFailure?: boolean }).calendarFailure = true;
      if (response.status === 401 || response.status === 403) {
        (error as Error & { googleAuthFailure: boolean }).googleAuthFailure = true;
      }
      throw error;
    }

    return await response.json() as Record<string, unknown>;
  }

  async updateEvent(eventId: string, patch: Partial<CalendarRequest>, accessToken?: string): Promise<Record<string, unknown>> {
    if (!accessToken) {
      return {
        status: "skipped",
        reason: "Missing Google access token",
        eventId
      };
    }

    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      body.summary = patch.title;
    }
    if (patch.startAt !== undefined) {
      body.start = { dateTime: patch.startAt };
    }
    if (patch.endAt !== undefined) {
      body.end = { dateTime: patch.endAt };
    }
    if (patch.notes !== undefined) {
      body.description = patch.notes;
    }
    if (patch.participants !== undefined) {
      body.attendees = patch.participants.filter(isValidEmail).map((email) => ({ email }));
    }

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Google Calendar update error: ${response.status} ${text}`);
      (error as Error & { calendarFailure: boolean }).calendarFailure = true;
      throw error;
    }

    return await response.json() as Record<string, unknown>;
  }
}
