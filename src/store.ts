import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { conflict, notFound } from "./errors.js";
import { gatewayId } from "./ids.js";
import type { AgentEvent, AgentRun, AgentSession, Project, RunStatus, SessionStatus } from "./types.js";

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
    const current = this.getRun(runId);
    if (!validRunTransition(current.status, status)) throw conflict(`Run cannot transition from ${current.status} to ${status}.`);
    this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), runId);
    return this.getRun(runId);
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
