import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "./config.js";
import type {
  ApprovalDecision,
  ProviderApprovalBinding,
  ProviderApprovalRequest,
  ProviderApprovalType,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequestId,
} from "./types.js";

export interface StartRunResult { providerRunId: string }

export interface AgentProvider {
  readonly id: "codex";
  readonly capabilities: ProviderCapabilities;
  startSession(workspacePath: string): Promise<string>;
  resumeSession(providerSessionId: string): Promise<void>;
  startRun(providerSessionId: string, text: string): Promise<StartRunResult>;
  interruptRun(providerSessionId: string, providerRunId: string): Promise<void>;
  respondToApproval(binding: ProviderApprovalBinding, decision: ApprovalDecision): Promise<void>;
  rejectApproval(binding: ProviderApprovalBinding): Promise<void>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  close(): Promise<void>;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRpcRequest {
  generation: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcProcess extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private generation = 0;
  private readonly pending = new Map<string, PendingRpcRequest>();

  constructor(private readonly command: string, private readonly args: string[]) { super(); }

  async start(): Promise<void> {
    if (this.process && !this.process.killed) return;
    const generation = this.generation + 1;
    this.generation = generation;
    this.buffer = "";
    const child = spawn(this.command, this.args, { stdio: "pipe", windowsHide: true });
    this.process = child;
    let ended = false;
    const finish = (error: Error) => {
      if (ended) return;
      ended = true;
      if (this.process === child) this.process = undefined;
      this.failAll(error, generation);
      this.emit("exit", generation);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk, generation));
    child.stderr.on("data", () => undefined); // Provider stderr may contain prompts and is never forwarded to clients.
    child.on("error", (error) => finish(new Error(`Codex App Server could not start: ${error.message}`)));
    child.on("exit", () => finish(new Error("Codex App Server exited.")));
  }

  get connectionGeneration(): number { return this.generation; }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex App Server is not connected."));
    const id = randomUUID();
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const generation = this.generation;
      this.pending.set(id, { generation, resolve, reject });
      this.process!.stdin.write(`${message}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(new Error("Failed to send request to Codex App Server."));
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server is not connected.");
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  respondResult(id: ProviderRequestId, generation: number, result: Record<string, unknown>): Promise<void> {
    return this.writeResponse(generation, { jsonrpc: "2.0", id, result });
  }

  respondError(id: ProviderRequestId, generation: number, message: string): Promise<void> {
    return this.writeResponse(generation, { jsonrpc: "2.0", id, error: { code: -32001, message } });
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  private writeResponse(generation: number, message: Record<string, unknown>): Promise<void> {
    const child = this.process;
    if (generation !== this.generation || !child?.stdin.writable) {
      return Promise.reject(new Error("Codex App Server request belongs to an unavailable connection."));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new Error("Failed to respond to Codex App Server."));
        else resolve();
      });
    });
  }

  private consume(chunk: string, generation: number): void {
    if (generation !== this.generation) return;
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try { this.handle(JSON.parse(line) as RpcMessage, generation); } catch { this.emit("protocolError"); }
    }
  }

  private handle(message: RpcMessage, generation: number): void {
    if (message.id !== undefined && message.method) {
      if ((typeof message.id !== "string" && typeof message.id !== "number") || typeof message.method !== "string") {
        this.emit("protocolError");
        return;
      }
      this.emit("serverRequest", generation, message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending || pending.generation !== generation) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex App Server returned an error."));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.emit("notification", generation, message.method, message.params);
  }

  private failAll(error: Error, generation: number): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function idFromResult(value: unknown, keys: string[]): string {
  const result = record(value);
  for (const key of keys) {
    const direct = result[key];
    if (typeof direct === "string") return direct;
    const nested = record(direct).id;
    if (typeof nested === "string") return nested;
  }
  throw new Error("Codex App Server response did not include the expected identifier.");
}

const APPROVAL_METHODS: Readonly<Record<string, ProviderApprovalType>> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permission",
};
const BASIC_APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
const CONSERVATIVE_APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["accept", "decline", "cancel"];

interface PendingProviderApproval {
  request: ProviderApprovalRequest;
  state: "pending" | "responded";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requestKey(generation: number, requestId: ProviderRequestId): string {
  return `${generation}:${typeof requestId}:${String(requestId)}`;
}

function availableDecisions(value: unknown, type: ProviderApprovalType): ApprovalDecision[] {
  if (type === "permission") return [];
  if (!Array.isArray(value)) return [...CONSERVATIVE_APPROVAL_DECISIONS];
  const allowed = new Set<ApprovalDecision>(BASIC_APPROVAL_DECISIONS);
  return [...new Set(value.filter((decision): decision is ApprovalDecision => typeof decision === "string" && allowed.has(decision as ApprovalDecision)))];
}

function parseApprovalRequest(
  generation: number,
  requestId: ProviderRequestId,
  method: string,
  value: unknown,
): ProviderApprovalRequest | undefined {
  const type = APPROVAL_METHODS[method];
  if (!type) return undefined;
  const params = record(value);
  const providerSessionId = optionalString(params.threadId);
  const providerRunId = optionalString(params.turnId);
  const providerItemId = optionalString(params.itemId);
  if (!providerSessionId || !providerRunId || !providerItemId || !Number.isInteger(params.startedAtMs)) return undefined;
  const binding: ProviderApprovalBinding = {
    providerRequestId: requestId,
    connectionGeneration: generation,
    providerSessionId,
    providerRunId,
    providerItemId,
    ...(optionalString(params.approvalId) ? { providerApprovalId: optionalString(params.approvalId) } : {}),
  };
  const decisions = availableDecisions(params.availableDecisions, type);
  if (type === "command") {
    return {
      type,
      binding,
      availableDecisions: decisions,
      details: {
        type,
        kind: params.kind === "writeStdin" ? "writeStdin" : "command",
        ...(optionalString(params.command) ? { command: optionalString(params.command) } : {}),
        ...(optionalString(params.cwd) ? { cwd: optionalString(params.cwd) } : {}),
        ...(optionalString(params.reason) ? { reason: optionalString(params.reason) } : {}),
      },
    };
  }
  if (type === "fileChange") {
    return {
      type,
      binding,
      availableDecisions: decisions,
      details: {
        type,
        ...(optionalString(params.grantRoot) ? { grantRoot: optionalString(params.grantRoot) } : {}),
        ...(optionalString(params.reason) ? { reason: optionalString(params.reason) } : {}),
      },
    };
  }
  const permissions = record(params.permissions);
  const cwd = optionalString(params.cwd);
  if (!cwd || Object.keys(permissions).length === 0) return undefined;
  return {
    type,
    binding,
    availableDecisions: [],
    details: {
      type,
      cwd,
      permissions,
      ...(optionalString(params.reason) ? { reason: optionalString(params.reason) } : {}),
    },
  };
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    resumableSessions: true, eventStreaming: true, interruptRun: true,
    commandApproval: false, fileChangeApproval: false, permissionApproval: false, workspaceAccess: true,
  };
  private readonly rpc: JsonRpcProcess;
  private initialization: Promise<void> | undefined;
  private closing = false;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly pendingApprovals = new Map<string, PendingProviderApproval>();

  constructor(config: Pick<GatewayConfig, "codexCommand" | "codexArgs">) {
    this.rpc = new JsonRpcProcess(config.codexCommand, config.codexArgs);
    this.rpc.on("notification", (generation: number, method: string, params: unknown) => this.handleNotification(generation, method, params));
    this.rpc.on("serverRequest", (generation: number, id: ProviderRequestId, method: string, params: unknown) => this.handleServerRequest(generation, id, method, params));
    this.rpc.on("exit", (generation: number) => {
      this.clearApprovalsForGeneration(generation);
      if (!this.closing) this.emit({ type: "providerError", providerSessionId: "", message: "Codex App Server disconnected." });
    });
    this.rpc.on("protocolError", () => this.emit({ type: "providerError", providerSessionId: "", message: "Codex App Server sent an invalid protocol message." }));
  }

  async startSession(workspacePath: string): Promise<string> {
    await this.initialize();
    const result = await this.rpc.request("thread/start", { cwd: workspacePath });
    return idFromResult(result, ["threadId", "thread"]);
  }
  async resumeSession(providerSessionId: string): Promise<void> {
    await this.initialize();
    await this.rpc.request("thread/resume", { threadId: providerSessionId });
  }
  async startRun(providerSessionId: string, text: string): Promise<StartRunResult> {
    await this.initialize();
    const result = await this.rpc.request("turn/start", {
      threadId: providerSessionId,
      input: [{ type: "text", text }],
    });
    return { providerRunId: idFromResult(result, ["turnId", "turn"]) };
  }
  async interruptRun(providerSessionId: string, providerRunId: string): Promise<void> {
    await this.initialize();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.rpc.request("turn/interrupt", { threadId: providerSessionId, turnId: providerRunId });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.includes("no active turn") || attempt === 7) throw error;
        // Codex can acknowledge turn/start shortly before the turn becomes interruptible.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  async respondToApproval(binding: ProviderApprovalBinding, decision: ApprovalDecision): Promise<void> {
    const pending = this.claimApproval(binding);
    if (pending.request.type === "permission") throw new Error("Permission approval is not supported by this Gateway version.");
    if (!pending.request.availableDecisions.includes(decision)) throw new Error("The requested approval decision is not available.");
    pending.state = "responded";
    try {
      await this.rpc.respondResult(binding.providerRequestId, binding.connectionGeneration, { decision });
    } catch (error) {
      this.pendingApprovals.delete(requestKey(binding.connectionGeneration, binding.providerRequestId));
      throw error;
    }
  }
  async rejectApproval(binding: ProviderApprovalBinding): Promise<void> {
    const pending = this.claimApproval(binding);
    pending.state = "responded";
    try {
      await this.rpc.respondError(binding.providerRequestId, binding.connectionGeneration, "Approval is not supported in Phase 1.");
    } catch (error) {
      this.pendingApprovals.delete(requestKey(binding.connectionGeneration, binding.providerRequestId));
      throw error;
    }
  }
  onEvent(listener: (event: ProviderEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.closing = true; this.pendingApprovals.clear(); await this.rpc.close(); }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeWithRetry().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async initializeWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.rpc.start();
        await this.rpc.request("initialize", { clientInfo: { name: "desktop-gateway-agent", version: "0.1.0" } });
        this.rpc.notify("initialized");
        return;
      } catch (error) {
        lastError = error;
        await this.rpc.close();
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }

  private handleNotification(generation: number, method: string, value: unknown): void {
    const params = record(value);
    const providerSessionId = typeof params.threadId === "string" ? params.threadId : "";
    const providerRunId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if ((typeof requestId !== "string" && typeof requestId !== "number") || !providerSessionId) return;
      const key = requestKey(generation, requestId);
      const pending = this.pendingApprovals.get(key);
      if (!pending || pending.request.binding.providerSessionId !== providerSessionId) return;
      this.pendingApprovals.delete(key);
      this.emit({
        type: "approvalResolved",
        providerSessionId,
        providerRunId: pending.request.binding.providerRunId,
        approval: pending.request,
      });
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (providerSessionId && delta) this.emit({ type: "messageDelta", providerSessionId, providerRunId, text: delta });
      return;
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
      const turnId = providerRunId ?? (typeof turn.id === "string" ? turn.id : undefined);
      if (turnId) this.clearApprovalsForRun(providerSessionId, turnId);
      if (providerSessionId) this.emit({ type: "runCompleted", providerSessionId, providerRunId: turnId, status });
      return;
    }
  }

  private handleServerRequest(generation: number, id: ProviderRequestId, method: string, value: unknown): void {
    const approval = parseApprovalRequest(generation, id, method, value);
    if (approval) {
      const key = requestKey(generation, id);
      if (this.pendingApprovals.has(key)) return;
      this.pendingApprovals.set(key, { request: approval, state: "pending" });
      this.emit({
        type: "approvalRequested",
        providerSessionId: approval.binding.providerSessionId,
        providerRunId: approval.binding.providerRunId,
        approval,
      });
      return;
    }
    const message = APPROVAL_METHODS[method]
      ? "Codex App Server sent an invalid approval request."
      : "This Gateway does not support the requested Codex server action.";
    void this.rpc.respondError(id, generation, message).catch(() => undefined);
  }

  private claimApproval(binding: ProviderApprovalBinding): PendingProviderApproval {
    const pending = this.pendingApprovals.get(requestKey(binding.connectionGeneration, binding.providerRequestId));
    const stored = pending?.request.binding;
    if (!pending || pending.state !== "pending" || !stored
      || stored.providerSessionId !== binding.providerSessionId
      || stored.providerRunId !== binding.providerRunId
      || stored.providerItemId !== binding.providerItemId
      || stored.providerApprovalId !== binding.providerApprovalId) {
      throw new Error("Approval request is no longer pending on this Provider connection.");
    }
    return pending;
  }

  private clearApprovalsForGeneration(generation: number): void {
    for (const [key, pending] of this.pendingApprovals) {
      if (pending.request.binding.connectionGeneration === generation) this.pendingApprovals.delete(key);
    }
  }

  private clearApprovalsForRun(providerSessionId: string, providerRunId: string): void {
    for (const [key, pending] of this.pendingApprovals) {
      const binding = pending.request.binding;
      if (binding.providerSessionId === providerSessionId && binding.providerRunId === providerRunId) this.pendingApprovals.delete(key);
    }
  }

  private emit(event: ProviderEvent): void { for (const listener of this.listeners) listener(event); }
}
