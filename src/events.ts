import type { AgentEvent } from "./types.js";

export class EventHub {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event: AgentEvent): void { for (const listener of this.listeners) listener(event); }
}
