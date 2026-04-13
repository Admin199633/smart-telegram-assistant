import { config } from "../config.js";
import { AppActionRequest } from "../types.js";
import { ActionRegistry } from "./action-registry.js";

export class AppActionService {
  constructor(private readonly registry: ActionRegistry) {}

  async execute(request: AppActionRequest): Promise<Record<string, unknown>> {
    const action = this.registry.get(request.appKey, request.actionName);
    if (!action) {
      throw new Error(`Action ${request.appKey}/${request.actionName} is not registered`);
    }

    const apiKey = config.appActionApiKeys[request.appKey];
    const response = await fetch(action.executionEndpoint, {
      method: action.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(request.inputs)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`App action failed: ${response.status} ${body}`);
    }

    return await response.json() as Record<string, unknown>;
  }
}
