import fs from "node:fs";
import path from "node:path";
import { AuditEntry, ClarificationState, ConversationTurn, GoogleTokens, OAuthState, ProposedAction, UserProfile } from "../types.js";

export class MemoryStore {
  private readonly profiles = new Map<string, UserProfile>();
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly pendingActions = new Map<string, ProposedAction>();
  private readonly pendingActionByUser = new Map<string, string>();
  private readonly clarifications = new Map<string, ClarificationState>();
  private readonly googleTokens = new Map<string, GoogleTokens>();
  private readonly oauthStates = new Map<string, OAuthState>();
  private readonly auditLog: AuditEntry[] = [];
  private readonly tokensFilePath = path.join(process.cwd(), "data", "google-tokens.json");

  constructor() {
    this.loadPersistedTokens();
  }

  getOrCreateProfile(userId: string, timezone: string): UserProfile {
    const existing = this.profiles.get(userId);
    if (existing) {
      return existing;
    }

    const profile: UserProfile = {
      userId,
      language: "he",
      tonePreferences: {
        defaultTone: "business",
        supportsDualTone: true
      },
      frequentContacts: [],
      schedulingPreferences: {
        timezone
      }
    };
    this.profiles.set(userId, profile);
    return profile;
  }

  updateProfile(profile: UserProfile): UserProfile {
    this.profiles.set(profile.userId, profile);
    return profile;
  }

  listConversation(userId: string): ConversationTurn[] {
    return this.conversations.get(userId) ?? [];
  }

  appendConversation(userId: string, turn: ConversationTurn): void {
    const turns = this.listConversation(userId);
    turns.push(turn);
    this.conversations.set(userId, turns.slice(-20));
  }

  savePendingAction(action: ProposedAction): void {
    this.pendingActions.set(action.id, action);
  }

  getPendingAction(actionId: string): ProposedAction | undefined {
    return this.pendingActions.get(actionId);
  }

  removePendingAction(actionId: string): void {
    this.pendingActions.delete(actionId);
  }

  setPendingActionUser(userId: string, actionId: string): void {
    this.pendingActionByUser.set(userId, actionId);
  }

  getPendingActionIdForUser(userId: string): string | undefined {
    return this.pendingActionByUser.get(userId);
  }

  clearPendingActionUser(userId: string): void {
    this.pendingActionByUser.delete(userId);
  }

  saveClarification(state: ClarificationState): void {
    this.clarifications.set(state.userId, state);
  }

  getClarification(userId: string): ClarificationState | undefined {
    return this.clarifications.get(userId);
  }

  clearClarification(userId: string): void {
    this.clarifications.delete(userId);
  }

  saveGoogleTokens(userId: string, tokens: GoogleTokens): void {
    this.googleTokens.set(userId, tokens);
    this.persistTokens();
  }

  getGoogleTokens(userId: string): GoogleTokens | undefined {
    return this.googleTokens.get(userId);
  }

  clearGoogleTokens(userId: string): void {
    this.googleTokens.delete(userId);
    this.persistTokens();
  }

  saveOAuthState(stateId: string, state: OAuthState): void {
    this.oauthStates.set(stateId, state);
  }

  consumeOAuthState(stateId: string): OAuthState | undefined {
    const state = this.oauthStates.get(stateId);
    this.oauthStates.delete(stateId);
    return state;
  }

  addAuditEntry(entry: AuditEntry): void {
    this.auditLog.push(entry);
  }

  listAuditEntries(): AuditEntry[] {
    return [...this.auditLog];
  }

  private loadPersistedTokens(): void {
    try {
      if (!fs.existsSync(this.tokensFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.tokensFilePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, GoogleTokens>;
      for (const [userId, tokens] of Object.entries(parsed)) {
        this.googleTokens.set(userId, tokens);
      }
    } catch {
      // Best-effort load; the app can continue with in-memory tokens only.
    }
  }

  private persistTokens(): void {
    try {
      fs.mkdirSync(path.dirname(this.tokensFilePath), { recursive: true });
      const serializable = Object.fromEntries(this.googleTokens.entries());
      fs.writeFileSync(this.tokensFilePath, JSON.stringify(serializable, null, 2), "utf8");
    } catch {
      // Best-effort persistence; requests should still succeed in memory.
    }
  }
}
