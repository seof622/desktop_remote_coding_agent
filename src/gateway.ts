import { GatewayError, conflict } from "./errors.js";
import { EventHub } from "./events.js";
import type { AgentProvider } from "./provider.js";
import { GatewayStore } from "./store.js";
import type { AgentEvent, AgentRun, AgentSession, Project, ProviderEvent, RunStatus } from "./types.js";

export class GatewayService {
  readonly events = new EventHub();

  constructor(private readonly store: GatewayStore, private readonly provider: AgentProvider) {
    provider.onEvent((event) => { void this.handleProviderEvent(event); });
  }

  getCapabilities() { return this.provider.capabilities; }
  listProjects(): Project[] { return this.store.listProjects(); }
  getProject(projectId: string): Project { return this.store.getProject(projectId); }
  createProject(name: string, workspacePath: string): Project { return this.store.createProject(name, workspacePath); }
  listSessions(): AgentSession[] { return this.store.listSessions(); }
  getSession(sessionId: string): AgentSession { return this.store.getSession(sessionId); }
  listEvents(sessionId: string, afterSequence?: number): AgentEvent[] { this.store.getSession(sessionId); return this.store.listEvents(sessionId, afterSequence); }

  async startSession(projectId: string): Promise<AgentSession> {
    const project = this.store.getProject(projectId);
    const providerSessionId = await this.provider.startSession(project.workspacePath);
    const session = this.store.createSession(project.id, providerSessionId);
    this.publish({ type: "session.started", projectId: project.id, sessionId: session.id, payload: { status: session.status } });
    return session;
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.store.getSession(sessionId);
    if (session.status !== "Active") throw conflict("Only active sessions can be resumed.");
    try {
      await this.provider.resumeSession(session.providerSessionId);
      return session;
    } catch {
      return this.store.updateSessionStatus(session.id, "Unavailable");
    }
  }

  async startRun(sessionId: string, text: string): Promise<AgentRun> {
    const session = this.store.getSession(sessionId);
    if (session.status !== "Active") throw conflict("Only active sessions can start a run.");
    const run = this.store.createRun(session.id);
    try {
      const started = await this.provider.startRun(session.providerSessionId, text);
      const stored = this.store.setRunProviderId(run.id, started.providerRunId);
      const running = this.store.updateRunStatus(stored.id, "Running");
      this.publish({ type: "run.started", projectId: session.projectId, sessionId: session.id, runId: running.id, payload: { status: running.status } });
      return running;
    } catch {
      const failed = this.store.updateRunStatus(run.id, "Failed");
      this.publish({ type: "error", projectId: session.projectId, sessionId: session.id, runId: failed.id, payload: { code: "PROVIDER_UNAVAILABLE", message: "Codex App Server could not start the run." } });
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Codex App Server could not start the run.");
    }
  }

  async interrupt(sessionId: string): Promise<AgentRun> {
    const session = this.store.getSession(sessionId);
    const active = this.store.listRuns(sessionId).find((run) => ["Queued", "Running"].includes(run.status));
    if (!active) throw conflict("This session has no active run to interrupt.");
    if (!active.providerRunId) throw conflict("The run is not ready to be interrupted.");
    const interrupting = this.store.updateRunStatus(active.id, "Interrupting");
    try {
      await this.provider.interruptRun(session.providerSessionId, active.providerRunId);
      return interrupting;
    } catch {
      const failed = this.store.updateRunStatus(active.id, "Failed");
      this.publish({ type: "error", projectId: session.projectId, sessionId, runId: failed.id, payload: { code: "PROVIDER_UNAVAILABLE", message: "Codex App Server could not interrupt the run." } });
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Codex App Server could not interrupt the run.");
    }
  }

  private async handleProviderEvent(event: ProviderEvent): Promise<void> {
    if (event.type === "providerError" && !event.providerSessionId) {
      for (const session of this.store.listSessions().filter((item) => item.status === "Active")) {
        const run = this.store.listRuns(session.id).find((item) => ["Queued", "Running", "Interrupting"].includes(item.status));
        if (run) await this.failRun(session, run, "PROVIDER_DISCONNECTED", "Codex App Server disconnected.");
      }
      return;
    }
    const session = this.store.findSessionByProviderId(event.providerSessionId);
    if (!session) return;
    const run = event.providerRunId ? this.store.findRunByProviderId(event.providerRunId) : this.store.listRuns(session.id).find((item) => ["Queued", "Running", "Interrupting"].includes(item.status));
    if (event.type === "messageDelta" && run && event.text) {
      this.publish({ type: "agent.message.delta", projectId: session.projectId, sessionId: session.id, runId: run.id, payload: { delta: event.text } });
      return;
    }
    if (event.type === "runCompleted" && run) {
      const finalStatus: RunStatus = event.status === "interrupted" ? "Interrupted" : event.status === "failed" ? "Failed" : "Completed";
      let completed: AgentRun;
      try { completed = this.store.updateRunStatus(run.id, finalStatus); } catch { return; }
      this.publish({ type: "run.completed", projectId: session.projectId, sessionId: session.id, runId: completed.id, payload: { status: completed.status } });
      return;
    }
    if (event.type === "approvalRequested" && run) {
      this.publish({ type: "agent.status", projectId: session.projectId, sessionId: session.id, runId: run.id, payload: { status: "WaitingApproval" } });
      await this.failRun(session, run, "APPROVAL_UNSUPPORTED", "Approval is not supported in Phase 1.");
      return;
    }
    if (event.type === "providerError" && run) await this.failRun(session, run, "PROVIDER_ERROR", event.message ?? "Codex App Server reported an error.");
  }

  private async failRun(session: AgentSession, run: AgentRun, code: string, message: string): Promise<void> {
    let failed: AgentRun;
    try { failed = this.store.updateRunStatus(run.id, "Failed"); } catch { return; }
    this.publish({ type: "error", projectId: session.projectId, sessionId: session.id, runId: failed.id, payload: { code, message } });
  }

  private publish(event: Omit<AgentEvent, "eventId" | "sequence" | "occurredAt" | "providerId">): void {
    this.events.publish(this.store.appendEvent({ ...event, providerId: "codex" }));
  }
}
