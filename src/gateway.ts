import { approvalDisplay } from "./approval.js";
import { GatewayError, conflict } from "./errors.js";
import { EventHub } from "./events.js";
import type { AgentProvider } from "./provider.js";
import { GatewayStore } from "./store.js";
import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  Project,
  ProviderEvent,
  RunStatus,
} from "./types.js";

function safeProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provider error.";
  return message
    .replace(/((?:authorization|token|api[_-]?key)\s*[=:])\s*\S+/gi, "$1 <redacted>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z]:\\[^\s\"']+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s\"']+/g, "<path>")
    .slice(0, 300);
}

export class GatewayService {
  readonly events = new EventHub();
  private readonly deferredProviderEvents = new Map<string, ProviderEvent[]>();

  constructor(private readonly store: GatewayStore, private readonly provider: AgentProvider) {
    for (const approval of store.listApprovals().filter((item) => item.status !== "Resolved")) {
      this.publishApprovalResolved(store.resolveApproval(approval.id, "PROVIDER_APPROVAL_UNAVAILABLE"));
    }
    provider.onEvent((event) => { void this.handleProviderEvent(event); });
  }

  getCapabilities() { return this.provider.capabilities; }
  listProjects(): Project[] { return this.store.listProjects(); }
  getProject(projectId: string): Project { return this.store.getProject(projectId); }
  createProject(name: string, workspacePath: string): Project { return this.store.createProject(name, workspacePath); }
  listSessions(): AgentSession[] { return this.store.listSessions(); }
  getSession(sessionId: string): AgentSession { return this.store.getSession(sessionId); }
  listEvents(sessionId: string, afterSequence?: number): AgentEvent[] { this.store.getSession(sessionId); return this.store.listEvents(sessionId, afterSequence); }
  listApprovals(filter: { sessionId?: string; status?: ApprovalStatus } = {}): Approval[] {
    if (filter.sessionId) this.store.getSession(filter.sessionId);
    return this.store.listApprovals(filter);
  }
  getApproval(approvalId: string): Approval { return this.store.getApproval(approvalId); }

  async decideApproval(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    const claimed = this.store.claimApprovalDecision(approvalId, decision);
    const session = this.store.getSession(claimed.approval.sessionId);
    const run = this.store.getRun(claimed.approval.runId);
    if (run.sessionId !== session.id || session.projectId !== claimed.approval.projectId) {
      throw conflict("Approval ownership no longer matches its Session and Run.");
    }
    try {
      await this.provider.respondToApproval(claimed.binding, decision);
    } catch {
      const resolved = this.store.resolveApproval(approvalId, "PROVIDER_RESPONSE_FAILED");
      this.publishApprovalResolved(resolved);
      await this.failRun(session, run, "PROVIDER_APPROVAL_UNAVAILABLE", "The approval decision could not be delivered.");
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "The approval decision could not be delivered.");
    }
    this.publishRunApprovalStatus(session, run);
    return this.store.getApproval(approvalId);
  }

  async startSession(projectId: string): Promise<AgentSession> {
    const project = this.store.getProject(projectId);
    let providerSessionId: string;
    try {
      providerSessionId = await this.provider.startSession(project.workspacePath);
    } catch (error) {
      console.error(`[Gateway] Codex Session start failed: ${safeProviderFailure(error)}`);
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Codex App Server could not start the session.");
    }
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
      await this.drainDeferredProviderEvents(session.providerSessionId, started.providerRunId);
      return this.store.getRun(running.id);
    } catch {
      await this.rejectDeferredApprovals(session.providerSessionId);
      const failed = this.transitionRun(session, run, "Failed");
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
      const failed = this.transitionRun(session, active, "Failed");
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
    if (!session) {
      if (event.type === "approvalRequested") {
        try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
      }
      return;
    }
    const run = event.providerRunId ? this.store.findRunByProviderId(event.providerRunId) : this.store.listRuns(session.id).find((item) => ["Queued", "Running", "Interrupting"].includes(item.status));
    if (!run && event.providerRunId) {
      const startingRun = this.store.listRuns(session.id).find((item) => item.status === "Queued" && item.providerRunId === null);
      if (startingRun) {
        const deferred = this.deferredProviderEvents.get(event.providerSessionId) ?? [];
        deferred.push(event);
        this.deferredProviderEvents.set(event.providerSessionId, deferred);
      } else if (event.type === "approvalRequested") {
        try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
      }
      return;
    }
    if (event.type === "messageDelta" && run && event.text) {
      this.publish({ type: "agent.message.delta", projectId: session.projectId, sessionId: session.id, runId: run.id, payload: { delta: event.text } });
      return;
    }
    if (event.type === "runCompleted" && run) {
      const finalStatus: RunStatus = event.status === "interrupted" ? "Interrupted" : event.status === "failed" ? "Failed" : "Completed";
      let completed: AgentRun;
      try { completed = this.transitionRun(session, run, finalStatus); } catch { return; }
      this.publish({ type: "run.completed", projectId: session.projectId, sessionId: session.id, runId: completed.id, payload: { status: completed.status } });
      return;
    }
    if (event.type === "approvalRequested" && run) {
      const supported = event.approval.type === "command"
        ? this.provider.capabilities.commandApproval
        : event.approval.type === "fileChange"
          ? this.provider.capabilities.fileChangeApproval
          : this.provider.capabilities.permissionApproval;
      if (!supported) {
        this.publish({ type: "agent.status", projectId: session.projectId, sessionId: session.id, runId: run.id, payload: { status: "WaitingApproval" } });
        try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
        await this.failRun(session, run, "APPROVAL_UNSUPPORTED", "This approval type is not supported.");
        return;
      }
      try {
        const existing = this.store.findApprovalByProviderBinding(event.approval.binding);
        const project = this.store.getProject(session.projectId);
        const approval = this.store.upsertApproval({
          type: event.approval.type,
          projectId: project.id,
          sessionId: session.id,
          runId: run.id,
          availableDecisions: event.approval.availableDecisions,
          display: approvalDisplay(project, event.approval),
          binding: event.approval.binding,
        });
        if (!existing) {
          this.publish({
            type: "approval.requested",
            projectId: project.id,
            sessionId: session.id,
            runId: run.id,
            payload: {
              approvalId: approval.id,
              type: approval.type,
              status: approval.status,
              itemId: approval.itemId,
              availableDecisions: approval.availableDecisions,
              display: approval.display,
            },
          });
          this.publish({ type: "agent.status", projectId: project.id, sessionId: session.id, runId: run.id, payload: { status: "WaitingApproval" } });
        }
      } catch {
        try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
        await this.failRun(session, run, "INVALID_APPROVAL", "The approval request did not match the active Run.");
      }
      return;
    }
    if (event.type === "approvalResolved" && run) {
      const approval = this.store.findApprovalByProviderBinding(event.approval.binding);
      if (!approval || approval.status === "Resolved") return;
      const resolved = this.store.resolveApproval(approval.id, "PROVIDER_RESOLVED");
      this.publishApprovalResolved(resolved);
      if (approval.status === "Pending" && ["Queued", "Running", "Interrupting"].includes(this.store.getRun(run.id).status)) {
        this.publishRunApprovalStatus(session, run);
      }
      return;
    }
    if (event.type === "providerError" && run) await this.failRun(session, run, "PROVIDER_ERROR", event.message ?? "Codex App Server reported an error.");
  }

  private async drainDeferredProviderEvents(providerSessionId: string, providerRunId: string): Promise<void> {
    const deferred = this.takeDeferredProviderEvents(providerSessionId);
    for (const event of deferred) {
      if (event.providerRunId === providerRunId) {
        await this.handleProviderEvent(event);
      } else if (event.type === "approvalRequested") {
        try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
      }
    }
  }

  private async rejectDeferredApprovals(providerSessionId: string): Promise<void> {
    for (const event of this.takeDeferredProviderEvents(providerSessionId)) {
      if (event.type !== "approvalRequested") continue;
      try { await this.provider.rejectApproval(event.approval.binding); } catch { /* The Provider request is already unavailable. */ }
    }
  }

  private takeDeferredProviderEvents(providerSessionId: string): ProviderEvent[] {
    const deferred = this.deferredProviderEvents.get(providerSessionId) ?? [];
    this.deferredProviderEvents.delete(providerSessionId);
    return deferred;
  }

  private async failRun(session: AgentSession, run: AgentRun, code: string, message: string): Promise<void> {
    let failed: AgentRun;
    try { failed = this.transitionRun(session, run, "Failed"); } catch { return; }
    this.publish({ type: "error", projectId: session.projectId, sessionId: session.id, runId: failed.id, payload: { code, message } });
  }

  private transitionRun(session: AgentSession, run: AgentRun, status: RunStatus): AgentRun {
    const unfinished = this.store.listApprovals({ runId: run.id }).filter((approval) => approval.status !== "Resolved");
    const updated = this.store.updateRunStatus(run.id, status);
    for (const approval of unfinished) this.publishApprovalResolved(this.store.getApproval(approval.id));
    return updated;
  }

  private publishApprovalResolved(approval: Approval): void {
    this.publish({
      type: "approval.resolved",
      projectId: approval.projectId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      payload: {
        approvalId: approval.id,
        status: approval.status,
        resolutionReason: approval.resolutionReason,
      },
    });
  }

  private publishRunApprovalStatus(session: AgentSession, run: AgentRun): void {
    const waiting = this.store.listApprovals({ runId: run.id, status: "Pending" }).length > 0;
    this.publish({
      type: "agent.status",
      projectId: session.projectId,
      sessionId: session.id,
      runId: run.id,
      payload: { status: waiting ? "WaitingApproval" : "Busy" },
    });
  }

  private publish(event: Omit<AgentEvent, "eventId" | "sequence" | "occurredAt" | "providerId">): void {
    this.events.publish(this.store.appendEvent({ ...event, providerId: "codex" }));
  }
}
