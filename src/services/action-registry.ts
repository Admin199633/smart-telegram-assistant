import { ActionDefinition } from "../types.js";

export class ActionRegistry {
  private readonly actions = new Map<string, ActionDefinition>();

  constructor(definitions: ActionDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: ActionDefinition): void {
    this.actions.set(this.key(definition.appKey, definition.actionName), definition);
  }

  get(appKey: string, actionName: string): ActionDefinition | undefined {
    return this.actions.get(this.key(appKey, actionName));
  }

  list(): ActionDefinition[] {
    return [...this.actions.values()];
  }

  private key(appKey: string, actionName: string): string {
    return `${appKey}:${actionName}`;
  }
}

export const defaultActions: ActionDefinition[] = [
  {
    appKey: "crm",
    actionName: "create_lead",
    description: "Creates a lead in the CRM",
    inputSchema: {
      name: "string",
      company: "string",
      notes: "string"
    },
    confirmationText: "ליצור ליד חדש ב-CRM",
    executionEndpoint: "https://example.internal/crm/leads",
    method: "POST"
  },
  {
    appKey: "ops",
    actionName: "trigger_runbook",
    description: "Triggers an operations runbook",
    inputSchema: {
      runbookId: "string",
      reason: "string"
    },
    confirmationText: "להפעיל runbook באפליקציית התפעול",
    executionEndpoint: "https://example.internal/ops/runbooks/trigger",
    method: "POST"
  }
];
