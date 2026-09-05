import type { AgentEvent } from "./types.js";

export class EventHub {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event: AgentEvent): void {
    for (const listener of this.listeners) {
      // A disconnected WebSocket must not roll back a persisted Session or Run transition.
      try { listener(event); } catch { this.listeners.delete(listener); }
    }
  }
}
