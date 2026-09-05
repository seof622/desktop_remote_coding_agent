import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "./config.js";
import type { ProviderCapabilities, ProviderEvent } from "./types.js";

export interface StartRunResult { providerRunId: string }

export interface AgentProvider {
  readonly id: "codex";
  readonly capabilities: ProviderCapabilities;
  startSession(workspacePath: string): Promise<string>;
  resumeSession(providerSessionId: string): Promise<void>;
  startRun(providerSessionId: string, text: string): Promise<StartRunResult>;
  interruptRun(providerSessionId: string, providerRunId: string): Promise<void>;
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

class JsonRpcProcess extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly command: string, private readonly args: string[]) { super(); }

  async start(): Promise<void> {
    if (this.process && !this.process.killed) return;
    const child = spawn(this.command, this.args, { stdio: "pipe", windowsHide: true });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", () => undefined); // Provider stderr may contain prompts and is never forwarded to clients.
    child.on("error", (error) => this.failAll(new Error(`Codex App Server could not start: ${error.message}`)));
    child.on("exit", () => {
      this.process = undefined;
      this.failAll(new Error("Codex App Server exited."));
      this.emit("exit");
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex App Server is not connected."));
    const id = randomUUID();
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

  respondError(id: string | number, message: string): void {
    if (!this.process?.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } })}\n`);
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try { this.handle(JSON.parse(line) as RpcMessage); } catch { this.emit("protocolError"); }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex App Server returned an error."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message.method, message.params);
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
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

  constructor(config: Pick<GatewayConfig, "codexCommand" | "codexArgs">) {
    this.rpc = new JsonRpcProcess(config.codexCommand, config.codexArgs);
    this.rpc.on("notification", (method: string, params: unknown) => this.handleNotification(method, params));
    this.rpc.on("serverRequest", (id: string | number, method: string, params: unknown) => this.handleServerRequest(id, method, params));
    this.rpc.on("exit", () => {
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
  onEvent(listener: (event: ProviderEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.closing = true; await this.rpc.close(); }

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

  private handleNotification(method: string, value: unknown): void {
    const params = record(value);
    const providerSessionId = typeof params.threadId === "string" ? params.threadId : "";
    const providerRunId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (providerSessionId && delta) this.emit({ type: "messageDelta", providerSessionId, providerRunId, text: delta });
      return;
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
      const turnId = providerRunId ?? (typeof turn.id === "string" ? turn.id : undefined);
      if (providerSessionId) this.emit({ type: "runCompleted", providerSessionId, providerRunId: turnId, status });
      return;
    }
    if (method.includes("approval") || method.includes("requestApproval")) {
      if (providerSessionId) this.emit({ type: "approvalRequested", providerSessionId, providerRunId, message: "Approval is not supported in Phase 1." });
    }
  }

  private handleServerRequest(id: string | number, method: string, value: unknown): void {
    const params = record(value);
    const providerSessionId = typeof params.threadId === "string" ? params.threadId : "";
    const providerRunId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (method.includes("requestApproval") || method.toLowerCase().includes("approval")) {
      if (providerSessionId) this.emit({ type: "approvalRequested", providerSessionId, providerRunId, message: "Approval is not supported in Phase 1." });
      // A JSON-RPC error denies the unsupported request without accepting any command or file change.
      this.rpc.respondError(id, "Approval is not supported in Phase 1.");
      return;
    }
    this.rpc.respondError(id, "This Gateway does not support the requested Codex server action.");
  }

  private emit(event: ProviderEvent): void { for (const listener of this.listeners) listener(event); }
}
