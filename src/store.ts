import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { conflict, invalidRequest, notFound } from "./errors.js";
import { gatewayId } from "./ids.js";
import type {
  AgentEvent,
  AgentRun,
  AgentSession,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  ApprovalType,
  Project,
  ProviderApprovalBinding,
  ProviderRequestId,
  RunStatus,
  SessionStatus,
} from "./types.js";

const ACTIVE_RUNS: RunStatus[] = ["Queued", "Running", "Interrupting"];

interface ProjectRow { id: string; name: string; workspace_path: string; created_at: string }
interface SessionRow {
  id: string; provider_id: "codex"; project_id: string; provider_session_id: string;
  status: SessionStatus; created_at: string; updated_at: string;
}
interface RunRow {
  id: string; session_id: string; provider_run_id: string | null; status: RunStatus;
  created_at: string; updated_at: string;
}
interface EventRow {
  event_id: string; sequence: number; type: AgentEvent["type"]; occurred_at: string;
  provider_id: "codex"; project_id: string; session_id: string; run_id: string | null; payload: string;
}
interface ApprovalRow {
  id: string; type: ApprovalType; status: ApprovalStatus; project_id: string; session_id: string;
  run_id: string; item_id: string; available_decisions: string; display: string; requested_at: string;
  decided_at: string | null; resolved_at: string | null; resolution_reason: string | null;
}
interface ProviderApprovalBindingRow {
  approval_id: string; provider_request_id: string; connection_generation: number; provider_session_id: string;
  provider_run_id: string; provider_item_id: string; provider_approval_id: string | null;
}

export interface CreateApprovalInput {
  type: ApprovalType;
  projectId: string;
  sessionId: string;
  runId: string;
  itemId: string;
  availableDecisions: ApprovalDecision[];
  display: Record<string, unknown>;
  binding: ProviderApprovalBinding;
  requestedAt?: string;
}

export interface ClaimedApproval {
  approval: Approval;
  binding: ProviderApprovalBinding;
}

const projectFrom = (row: ProjectRow): Project => ({ id: row.id, name: row.name, workspacePath: row.workspace_path, createdAt: row.created_at });
const sessionFrom = (row: SessionRow): AgentSession => ({
  id: row.id, providerId: row.provider_id, projectId: row.project_id, providerSessionId: row.provider_session_id,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
});
const runFrom = (row: RunRow): AgentRun => ({
  id: row.id, sessionId: row.session_id, providerRunId: row.provider_run_id,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
});
const eventFrom = (row: EventRow): AgentEvent => ({
  eventId: row.event_id, sequence: row.sequence, type: row.type, occurredAt: row.occurred_at,
  providerId: row.provider_id, projectId: row.project_id, sessionId: row.session_id,
  ...(row.run_id ? { runId: row.run_id } : {}), payload: JSON.parse(row.payload) as Record<string, unknown>,
});
const approvalFrom = (row: ApprovalRow): Approval => ({
  id: row.id,
  type: row.type,
  status: row.status,
  projectId: row.project_id,
  sessionId: row.session_id,
  runId: row.run_id,
  itemId: row.item_id,
  availableDecisions: JSON.parse(row.available_decisions) as ApprovalDecision[],
  display: JSON.parse(row.display) as Record<string, unknown>,
  requestedAt: row.requested_at,
  ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  ...(row.resolution_reason ? { resolutionReason: row.resolution_reason } : {}),
});
const bindingFrom = (row: ProviderApprovalBindingRow): ProviderApprovalBinding => ({
  providerRequestId: JSON.parse(row.provider_request_id) as ProviderRequestId,
  connectionGeneration: row.connection_generation,
  providerSessionId: row.provider_session_id,
  providerRunId: row.provider_run_id,
  providerItemId: row.provider_item_id,
  ...(row.provider_approval_id ? { providerApprovalId: row.provider_approval_id } : {}),
});

const APPROVAL_DECISIONS = new Set<ApprovalDecision>(["accept", "acceptForSession", "decline", "cancel"]);
const TERMINAL_RUNS = new Set<RunStatus>(["Completed", "Interrupted", "Failed"]);

export class GatewayStore {
  private readonly database: Database.Database;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.database = new Database(join(dataDirectory, "gateway.db"));
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
        provider_session_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), provider_run_id TEXT UNIQUE,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_by_session ON runs(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL,
        provider_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT REFERENCES runs(id), payload TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS event_sequence_by_session ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('command', 'fileChange', 'permission')),
        status TEXT NOT NULL CHECK (status IN ('Pending', 'Accepted', 'Declined', 'Cancelled', 'Resolved')),
        project_id TEXT NOT NULL REFERENCES projects(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        item_id TEXT NOT NULL,
        available_decisions TEXT NOT NULL,
        display TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        resolved_at TEXT,
        resolution_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_by_session_status ON approvals(session_id, status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS approvals_by_run_status ON approvals(run_id, status);
      CREATE TABLE IF NOT EXISTS provider_approval_bindings (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
        provider_request_id TEXT NOT NULL,
        connection_generation INTEGER NOT NULL,
        provider_session_id TEXT NOT NULL,
        provider_run_id TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
        provider_approval_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS provider_approval_request
        ON provider_approval_bindings(connection_generation, provider_request_id);
    `);
  }

  close(): void { this.database.close(); }

  listProjects(): Project[] { return (this.database.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as ProjectRow[]).map(projectFrom); }
  getProject(projectId: string): Project {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) throw notFound("Project");
    return projectFrom(row);
  }
  createProject(name: string, workspacePath: string): Project {
    const existing = this.database.prepare("SELECT * FROM projects WHERE workspace_path = ?").get(workspacePath) as ProjectRow | undefined;
    if (existing) return projectFrom(existing);
    const project: Project = { id: gatewayId("prj"), name, workspacePath, createdAt: new Date().toISOString() };
    this.database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(project.id, project.name, project.workspacePath, project.createdAt);
    return project;
  }

  listSessions(): AgentSession[] { return (this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[]).map(sessionFrom); }
  getSession(sessionId: string): AgentSession {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    if (!row) throw notFound("Session");
    return sessionFrom(row);
  }
  findSessionByProviderId(providerSessionId: string): AgentSession | undefined {
    const row = this.database.prepare("SELECT * FROM sessions WHERE provider_session_id = ?").get(providerSessionId) as SessionRow | undefined;
    return row ? sessionFrom(row) : undefined;
  }
  createSession(projectId: string, providerSessionId: string): AgentSession {
    this.getProject(projectId);
    const now = new Date().toISOString();
    const session: AgentSession = { id: gatewayId("ses"), providerId: "codex", projectId, providerSessionId, status: "Active", createdAt: now, updatedAt: now };
    this.database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(session.id, session.providerId, session.projectId, session.providerSessionId, session.status, now, now);
    return session;
  }
  updateSessionStatus(sessionId: string, status: SessionStatus): AgentSession {
    const changed = this.database.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), sessionId);
    if (changed.changes === 0) throw notFound("Session");
    return this.getSession(sessionId);
  }

  listRuns(sessionId: string): AgentRun[] {
    return (this.database.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as RunRow[]).map(runFrom);
  }
  getRun(runId: string): AgentRun {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) throw notFound("Run");
    return runFrom(row);
  }
  findRunByProviderId(providerRunId: string): AgentRun | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE provider_run_id = ?").get(providerRunId) as RunRow | undefined;
    return row ? runFrom(row) : undefined;
  }
  createRun(sessionId: string): AgentRun {
    this.getSession(sessionId);
    const create = this.database.transaction(() => {
      const active = this.database.prepare(`SELECT id FROM runs WHERE session_id = ? AND status IN ('Queued', 'Running', 'Interrupting')`).get(sessionId);
      if (active) throw conflict("This session already has an active run.");
      const now = new Date().toISOString();
      const run: AgentRun = { id: gatewayId("run"), sessionId, providerRunId: null, status: "Queued", createdAt: now, updatedAt: now };
      this.database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(run.id, run.sessionId, null, run.status, now, now);
      return run;
    });
    return create();
  }
  setRunProviderId(runId: string, providerRunId: string): AgentRun {
    const result = this.database.prepare("UPDATE runs SET provider_run_id = ?, updated_at = ? WHERE id = ?").run(providerRunId, new Date().toISOString(), runId);
    if (result.changes === 0) throw notFound("Run");
    return this.getRun(runId);
  }
  updateRunStatus(runId: string, status: RunStatus): AgentRun {
    const update = this.database.transaction(() => {
      const current = this.getRun(runId);
      if (!validRunTransition(current.status, status)) throw conflict(`Run cannot transition from ${current.status} to ${status}.`);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, runId);
      if (TERMINAL_RUNS.has(status)) {
        this.database.prepare(`
          UPDATE approvals
          SET status = 'Resolved', resolved_at = ?, resolution_reason = ?
          WHERE run_id = ? AND status <> 'Resolved'
        `).run(now, `RUN_${status.toUpperCase()}`, runId);
      }
      return this.getRun(runId);
    });
    return update();
  }

  listApprovals(filter: { sessionId?: string; runId?: string; status?: ApprovalStatus } = {}): Approval[] {
    return (this.database.prepare(`
      SELECT * FROM approvals
      WHERE (? IS NULL OR session_id = ?)
        AND (? IS NULL OR run_id = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY requested_at DESC, id DESC
    `).all(
      filter.sessionId ?? null, filter.sessionId ?? null,
      filter.runId ?? null, filter.runId ?? null,
      filter.status ?? null, filter.status ?? null,
    ) as ApprovalRow[]).map(approvalFrom);
  }

  getApproval(approvalId: string): Approval {
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
    if (!row) throw notFound("Approval");
    return approvalFrom(row);
  }

  getApprovalBinding(approvalId: string): ProviderApprovalBinding {
    const row = this.database.prepare("SELECT * FROM provider_approval_bindings WHERE approval_id = ?").get(approvalId) as ProviderApprovalBindingRow | undefined;
    if (!row) throw notFound("Approval binding");
    return bindingFrom(row);
  }

  upsertApproval(input: CreateApprovalInput): Approval {
    const availableDecisions = [...new Set(input.availableDecisions)];
    if (availableDecisions.some((decision) => !APPROVAL_DECISIONS.has(decision))) {
      throw invalidRequest("Approval includes an unsupported decision.");
    }
    if (!Number.isInteger(input.binding.connectionGeneration) || input.binding.connectionGeneration < 1
      || (typeof input.binding.providerRequestId === "number" && !Number.isFinite(input.binding.providerRequestId))
      || !input.binding.providerSessionId || !input.binding.providerRunId || !input.binding.providerItemId) {
      throw invalidRequest("Approval Provider binding is invalid.");
    }
    if (!input.itemId || input.itemId !== input.binding.providerItemId) {
      throw conflict("Approval item ownership does not match the Provider binding.");
    }
    const providerRequestId = JSON.stringify(input.binding.providerRequestId);
    const upsert = this.database.transaction(() => {
      const session = this.getSession(input.sessionId);
      const run = this.getRun(input.runId);
      if (session.projectId !== input.projectId || run.sessionId !== session.id) {
        throw conflict("Approval Project, Session, and Run ownership does not match.");
      }
      if (session.providerSessionId !== input.binding.providerSessionId
        || run.providerRunId !== input.binding.providerRunId) {
        throw conflict("Approval ownership does not match the Provider Session and Run.");
      }

      const existingBinding = this.database.prepare(`
        SELECT * FROM provider_approval_bindings
        WHERE connection_generation = ? AND provider_request_id = ?
      `).get(input.binding.connectionGeneration, providerRequestId) as ProviderApprovalBindingRow | undefined;
      if (existingBinding) {
        const existing = this.getApproval(existingBinding.approval_id);
        const storedBinding = bindingFrom(existingBinding);
        if (existing.type !== input.type
          || existing.projectId !== input.projectId
          || existing.sessionId !== input.sessionId
          || existing.runId !== input.runId
          || existing.itemId !== input.itemId
          || JSON.stringify(existing.availableDecisions) !== JSON.stringify(availableDecisions)
          || JSON.stringify(existing.display) !== JSON.stringify(input.display)
          || !sameProviderBinding(storedBinding, input.binding)) {
          throw conflict("Provider request ID is already bound to a different Approval.");
        }
        return existing;
      }
      if (!ACTIVE_RUNS.includes(run.status)) throw conflict("Approval cannot be attached to a finished Run.");

      const requestedAt = input.requestedAt ?? new Date().toISOString();
      const approval: Approval = {
        id: gatewayId("apr"),
        type: input.type,
        status: "Pending",
        projectId: input.projectId,
        sessionId: input.sessionId,
        runId: input.runId,
        itemId: input.itemId,
        availableDecisions,
        display: input.display,
        requestedAt,
      };
      this.database.prepare(`
        INSERT INTO approvals (
          id, type, status, project_id, session_id, run_id, item_id, available_decisions, display,
          requested_at, decided_at, resolved_at, resolution_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        approval.id, approval.type, approval.status, approval.projectId, approval.sessionId, approval.runId,
        approval.itemId, JSON.stringify(approval.availableDecisions), JSON.stringify(approval.display), approval.requestedAt,
      );
      this.database.prepare(`
        INSERT INTO provider_approval_bindings (
          approval_id, provider_request_id, connection_generation, provider_session_id,
          provider_run_id, provider_item_id, provider_approval_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval.id, providerRequestId, input.binding.connectionGeneration, input.binding.providerSessionId,
        input.binding.providerRunId, input.binding.providerItemId, input.binding.providerApprovalId ?? null,
      );
      return approval;
    });
    return upsert();
  }

  claimApprovalDecision(approvalId: string, decision: ApprovalDecision): ClaimedApproval {
    if (!APPROVAL_DECISIONS.has(decision)) throw invalidRequest("Approval decision is not supported.");
    const claim = this.database.transaction(() => {
      const approval = this.getApproval(approvalId);
      if (!approval.availableDecisions.includes(decision)) {
        throw invalidRequest("Approval decision is not available for this request.");
      }
      if (approval.status !== "Pending") throw conflict("Approval is no longer pending.");
      const status: ApprovalStatus = decision === "decline"
        ? "Declined"
        : decision === "cancel"
          ? "Cancelled"
          : "Accepted";
      const result = this.database.prepare(`
        UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'Pending'
      `).run(status, new Date().toISOString(), approvalId);
      if (result.changes !== 1) throw conflict("Approval is no longer pending.");
      return { approval: this.getApproval(approvalId), binding: this.getApprovalBinding(approvalId) };
    });
    return claim();
  }

  resolveApproval(approvalId: string, resolutionReason: string): Approval {
    if (!isResolutionReason(resolutionReason)) throw invalidRequest("Approval resolution reason is invalid.");
    const resolve = this.database.transaction(() => {
      const approval = this.getApproval(approvalId);
      if (approval.status === "Resolved") return approval;
      this.database.prepare(`
        UPDATE approvals
        SET status = 'Resolved', resolved_at = ?, resolution_reason = ?
        WHERE id = ? AND status <> 'Resolved'
      `).run(new Date().toISOString(), resolutionReason, approvalId);
      return this.getApproval(approvalId);
    });
    return resolve();
  }

  resolveApprovalsForRun(runId: string, resolutionReason: string): Approval[] {
    if (!isResolutionReason(resolutionReason)) throw invalidRequest("Approval resolution reason is invalid.");
    const resolve = this.database.transaction(() => {
      this.getRun(runId);
      this.database.prepare(`
        UPDATE approvals
        SET status = 'Resolved', resolved_at = ?, resolution_reason = ?
        WHERE run_id = ? AND status <> 'Resolved'
      `).run(new Date().toISOString(), resolutionReason, runId);
      return this.listApprovals({ runId });
    });
    return resolve();
  }

  appendEvent(event: Omit<AgentEvent, "eventId" | "sequence" | "occurredAt">): AgentEvent {
    const append = this.database.transaction(() => {
      const next = (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE session_id = ?").get(event.sessionId) as { sequence: number }).sequence;
      const saved: AgentEvent = { ...event, eventId: gatewayId("evt"), sequence: next, occurredAt: new Date().toISOString() };
      this.database.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(saved.eventId, saved.sequence, saved.type, saved.occurredAt, saved.providerId, saved.projectId, saved.sessionId, saved.runId ?? null, JSON.stringify(saved.payload));
      this.database.prepare("DELETE FROM events WHERE session_id = ? AND (occurred_at < datetime('now', '-7 days') OR sequence NOT IN (SELECT sequence FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1000))").run(saved.sessionId, saved.sessionId);
      return saved;
    });
    return append();
  }
  listEvents(sessionId: string, afterSequence = 0): AgentEvent[] {
    return (this.database.prepare("SELECT * FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC").all(sessionId, afterSequence) as EventRow[]).map(eventFrom);
  }
}

function sameProviderBinding(left: ProviderApprovalBinding, right: ProviderApprovalBinding): boolean {
  return left.providerRequestId === right.providerRequestId
    && left.connectionGeneration === right.connectionGeneration
    && left.providerSessionId === right.providerSessionId
    && left.providerRunId === right.providerRunId
    && left.providerItemId === right.providerItemId
    && left.providerApprovalId === right.providerApprovalId;
}

function isResolutionReason(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,119}$/.test(value);
}

function validRunTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  const transitions: Record<RunStatus, readonly RunStatus[]> = {
    Queued: ["Running", "Failed", "Interrupted"],
    Running: ["Interrupting", "Completed", "Interrupted", "Failed"],
    Interrupting: ["Interrupted", "Failed"],
    Completed: [], Interrupted: [], Failed: [],
  };
  return transitions[from].includes(to);
}
