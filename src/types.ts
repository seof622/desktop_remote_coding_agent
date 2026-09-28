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

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ApprovalType = "command" | "fileChange" | "permission";
export type ApprovalStatus = "Pending" | "Accepted" | "Declined" | "Cancelled" | "Resolved";

export interface Approval {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  projectId: string;
  sessionId: string;
  runId: string;
  itemId: string;
  availableDecisions: ApprovalDecision[];
  display: Record<string, unknown>;
  requestedAt: string;
  decidedAt?: string;
  resolvedAt?: string;
  resolutionReason?: string;
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

export type ProviderApprovalType = ApprovalType;
export type ProviderRequestId = string | number;

export interface ProviderApprovalBinding {
  providerRequestId: ProviderRequestId;
  connectionGeneration: number;
  providerSessionId: string;
  providerRunId: string;
  providerItemId: string;
  providerApprovalId?: string;
}

export interface ProviderApprovalRequest {
  type: ProviderApprovalType;
  binding: ProviderApprovalBinding;
  availableDecisions: ApprovalDecision[];
  details:
    | { type: "command"; kind: "command" | "writeStdin"; command?: string; cwd?: string; reason?: string }
    | { type: "fileChange"; grantRoot?: string; reason?: string }
    | { type: "permission"; cwd: string; permissions: Record<string, unknown>; reason?: string };
}

export type ProviderEvent =
  | { type: "messageDelta"; providerSessionId: string; providerRunId?: string; text: string }
  | { type: "runCompleted"; providerSessionId: string; providerRunId?: string; status: "completed" | "interrupted" | "failed" }
  | { type: "approvalRequested"; providerSessionId: string; providerRunId: string; approval: ProviderApprovalRequest }
  | { type: "approvalResolved"; providerSessionId: string; providerRunId: string; approval: ProviderApprovalRequest }
  | { type: "providerError"; providerSessionId: string; providerRunId?: string; message: string };
