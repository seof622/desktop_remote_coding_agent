import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { GatewayService } from "../src/gateway.js";
import type { AgentProvider, StartRunResult } from "../src/provider.js";
import { GatewayStore } from "../src/store.js";
import type { ProviderCapabilities, ProviderEvent } from "../src/types.js";

class FakeProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    resumableSessions: true, eventStreaming: true, interruptRun: true,
    commandApproval: false, fileChangeApproval: false, permissionApproval: false, workspaceAccess: true,
  };
  private listeners = new Set<(event: ProviderEvent) => void>();
  async startSession(): Promise<string> { return "thread_fake"; }
  async resumeSession(): Promise<void> {}
  async startRun(): Promise<StartRunResult> { return { providerRunId: "turn_fake" }; }
  async interruptRun(): Promise<void> {}
  onEvent(listener: (event: ProviderEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {}
  emit(event: ProviderEvent): void { for (const listener of this.listeners) listener(event); }
}

const token = "a".repeat(32);
const config: GatewayConfig = {
  clientToken: token, bindHost: "127.0.0.1", port: 8787, dataDir: "", workspaceRoots: [process.cwd()], codexCommand: "codex", codexArgs: ["app-server"],
};
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function createGateway() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-gateway-"));
  temporaryDirectories.push(directory);
  const store = new GatewayStore(directory);
  const provider = new FakeProvider();
  return { store, provider, gateway: new GatewayService(store, provider) };
}

describe("GatewayService", () => {
  it("maps provider IDs, streams normalized events, and completes a run", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const received: string[] = [];
    gateway.events.subscribe((event) => received.push(event.type));

    const run = await gateway.startRun(session.id, "hello");
    provider.emit({ type: "messageDelta", providerSessionId: "thread_fake", providerRunId: "turn_fake", text: "Hi" });
    provider.emit({ type: "runCompleted", providerSessionId: "thread_fake", providerRunId: "turn_fake", status: "completed" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.getRun(run.id).status).toBe("Completed");
    expect(gateway.listEvents(session.id).map((event) => event.type)).toEqual(["session.started", "run.started", "agent.message.delta", "run.completed"]);
    expect(received).toEqual(["run.started", "agent.message.delta", "run.completed"]);
    store.close();
  });

  it("rejects a second active run in one session", async () => {
    const { store, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "first");
    await expect(gateway.startRun(session.id, "second")).rejects.toMatchObject({ code: "CONFLICT" });
    store.close();
  });

  it("does not automatically approve a provider approval request", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "needs approval");
    provider.emit({ type: "approvalRequested", providerSessionId: "thread_fake", providerRunId: "turn_fake" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getRun(run.id).status).toBe("Failed");
    expect(gateway.listEvents(session.id).at(-1)?.payload).toMatchObject({ code: "APPROVAL_UNSUPPORTED" });
    store.close();
  });
});

describe("HTTP boundary", () => {
  it("requires a token before exposing even health data", async () => {
    const { store, gateway } = await createGateway();
    const app = await buildApp({ config, gateway });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/health", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "Online" });
    await app.close();
    store.close();
  });

  it("rejects a workspace outside the configured root", async () => {
    const { store, gateway } = await createGateway();
    const app = await buildApp({ config, gateway });
    const response = await app.inject({
      method: "POST", url: "/projects", headers: { authorization: `Bearer ${token}` },
      payload: { name: "blocked", workspacePath: tmpdir() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "WORKSPACE_NOT_ALLOWED" } });
    await app.close();
    store.close();
  });
});
