import fs from "node:fs";
import path from "node:path";
import { ShoppingList, ShoppingListItem } from "../types.js";
import { createId } from "../utils/id.js";

interface PersistedLists {
  listsByUser: Record<string, ShoppingList[]>;
  itemsByList: Record<string, ShoppingListItem[]>;
}

export class ListService {
  private readonly listsByUser = new Map<string, ShoppingList[]>();
  private readonly itemsByList = new Map<string, ShoppingListItem[]>();
  private readonly listsFilePath = path.join(process.cwd(), "data", "lists.json");

  constructor() {
    this.loadPersistedLists();
  }

  listLists(userId: string): ShoppingList[] {
    return [...(this.listsByUser.get(userId) ?? [])].sort((a, b) => {
      const aTime = a.lastUsedAt ?? a.createdAt;
      const bTime = b.lastUsedAt ?? b.createdAt;
      return bTime.localeCompare(aTime);
    });
  }

  touchList(listId: string): void {
    for (const [userId, lists] of this.listsByUser.entries()) {
      const idx = lists.findIndex((l) => l.id === listId);
      if (idx >= 0) {
        this.listsByUser.set(userId, lists.map((l) =>
          l.id === listId ? { ...l, lastUsedAt: new Date().toISOString() } : l
        ));
        this.persistLists();
        return;
      }
    }
  }

  findListByName(userId: string, name: string): ShoppingList | undefined {
    const normalizedName = normalizeListName(name);
    return this.listLists(userId).find((list) => normalizeListName(list.name) === normalizedName);
  }

  getOrCreateList(userId: string, name: string): ShoppingList {
    const normalizedName = normalizeListName(name);
    const existing = this.findListByName(userId, normalizedName);
    if (existing) {
      return existing;
    }

    const list: ShoppingList = {
      id: createId("list"),
      userId,
      name: normalizedName,
      createdAt: new Date().toISOString()
    };
    const lists = this.listLists(userId);
    this.listsByUser.set(userId, [...lists, list]);
    this.persistLists();
    return list;
  }

  listItems(listId: string): ShoppingListItem[] {
    return [...(this.itemsByList.get(listId) ?? [])];
  }

  addItem(listId: string, text: string): ShoppingListItem {
    const item: ShoppingListItem = {
      id: createId("item"),
      listId,
      text: text.trim(),
      status: "active",
      createdAt: new Date().toISOString()
    };
    const items = this.listItems(listId);
    this.itemsByList.set(listId, [...items, item]);
    return item;
  }

  addItems(listId: string, texts: string[]): ShoppingListItem[] {
    const result = texts.filter((t) => t.trim()).map((t) => this.addItem(listId, t));
    if (result.length > 0) this.touchList(listId);  // touchList also calls persistLists
    return result;
  }

  deleteList(userId: string, listId: string): boolean {
    const lists = this.listsByUser.get(userId) ?? [];
    const idx = lists.findIndex((l) => l.id === listId);
    if (idx < 0) return false;
    this.listsByUser.set(userId, lists.filter((l) => l.id !== listId));
    this.itemsByList.delete(listId);
    this.persistLists();
    return true;
  }

  removeItemByIndex(listId: string, index: number): boolean {
    const active = this.listItems(listId).filter((i) => i.status === "active");
    const target = active[index - 1];
    if (!target) return false;
    const all = this.itemsByList.get(listId) ?? [];
    this.itemsByList.set(listId, all.map((i) => i.id === target.id ? { ...i, status: "completed" as const } : i));
    this.persistLists();
    return true;
  }

  private loadPersistedLists(): void {
    try {
      if (!fs.existsSync(this.listsFilePath)) return;
      const raw = fs.readFileSync(this.listsFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedLists;
      for (const [userId, lists] of Object.entries(parsed.listsByUser ?? {})) {
        this.listsByUser.set(userId, lists);
      }
      for (const [listId, items] of Object.entries(parsed.itemsByList ?? {})) {
        this.itemsByList.set(listId, items);
      }
    } catch {
      // Best-effort load; the app continues with empty in-memory state.
    }
  }

  private persistLists(): void {
    try {
      fs.mkdirSync(path.dirname(this.listsFilePath), { recursive: true });
      const data: PersistedLists = {
        listsByUser: Object.fromEntries(this.listsByUser.entries()),
        itemsByList: Object.fromEntries(this.itemsByList.entries())
      };
      fs.writeFileSync(this.listsFilePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Best-effort persistence; requests still succeed in memory.
    }
  }
}

function normalizeListName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    // strip definite article "ה" prefix so "הקניות" resolves to the same list as "קניות"
    .replace(/^ה(?=[א-ת])/, "");
}
