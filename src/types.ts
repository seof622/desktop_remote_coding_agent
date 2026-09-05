export const PROVIDER_ID = "codex" as const;

export type GatewayStatus = "Online" | "Idle" | "Busy" | "WaitingApproval" | "Error";
export type SessionStatus = "Active" | "Archived" | "Unavailable";
export type RunStatus = "Queued" | "Running" | "Interrupting" | "Completed" | "Interrupted" | "Failed";
export type EventType =
  | "agent.status"
  | "session.started"
  | "run.started"
  | "agent.message.delta"
  | "run.completed"
  | "error";

export interface ProviderCapabilities {
  resumableSessions: boolean;
  eventStreaming: boolean;
  interruptRun: boolean;
  commandApproval: boolean;
  fileChangeApproval: boolean;
  permissionApproval: boolean;
  workspaceAccess: boolean;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  providerId: typeof PROVIDER_ID;
  projectId: string;
  providerSessionId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  providerRunId: string | null;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEvent {
  eventId: string;
  sequence: number;
  type: EventType;
  occurredAt: string;
  providerId: typeof PROVIDER_ID;
  projectId: string;
  sessionId: string;
  runId?: string;
  payload: Record<string, unknown>;
}

export interface ProviderEvent {
  type: "messageDelta" | "runCompleted" | "approvalRequested" | "providerError";
  providerSessionId: string;
  providerRunId?: string;
  text?: string;
  status?: "completed" | "interrupted" | "failed";
  message?: string;
}
