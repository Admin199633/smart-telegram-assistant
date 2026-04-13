import { WorklogAction, WorklogEntry } from "../types.js";
import { createId } from "../utils/id.js";

export class WorklogService {
  private readonly entries = new Map<string, WorklogEntry[]>();

  record(userId: string, action: WorklogAction, summary: string): WorklogEntry {
    const entry: WorklogEntry = {
      id: createId("wlog"),
      userId,
      action,
      summary,
      createdAt: new Date().toISOString()
    };

    const userEntries = this.entries.get(userId) ?? [];
    this.entries.set(userId, [...userEntries, entry]);
    return entry;
  }

  list(userId: string): WorklogEntry[] {
    return [...(this.entries.get(userId) ?? [])];
  }
}
