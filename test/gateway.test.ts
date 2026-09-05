import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { GatewayService } from "../src/gateway.js";
import { EventHub } from "../src/events.js";
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
  startSessionFailure?: Error;
  async startSession(): Promise<string> {
    if (this.startSessionFailure) throw this.startSessionFailure;
    return "thread_fake";
  }
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

function webSocketHandshake(address: string, protocol: string): Promise<string> {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket handshake timed out."));
    }, 2_000);
    socket.on("connect", () => socket.write([
      "GET /events HTTP/1.1",
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Sec-WebSocket-Protocol: ${protocol}`,
      "",
      "",
    ].join("\r\n")));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
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

describe("EventHub", () => {
  it("isolates a broken subscriber from the remaining event stream", () => {
    const events = new EventHub();
    const received: string[] = [];
    events.subscribe(() => { throw new Error("socket closed"); });
    events.subscribe((event) => received.push(event.type));
    events.publish({
      eventId: "evt_test", sequence: 1, type: "session.started", occurredAt: new Date().toISOString(),
      providerId: "codex", projectId: "prj_test", sessionId: "ses_test", payload: {},
    });
    expect(received).toEqual(["session.started"]);
  });
});

describe("HTTP boundary", () => {
  it("serves a data-free, non-cacheable test dashboard without a token", async () => {
    const { store, gateway } = await createGateway();
    const app = await buildApp({ config, gateway });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.body).toContain("Gateway 테스트 대시보드");
    expect(response.body).not.toContain(token);
    await app.close();
    store.close();
  });

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

  it("accepts a browser WebSocket only when its protocol carries the valid token", async () => {
    const { store, gateway } = await createGateway();
    const app = await buildApp({ config, gateway });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const validProtocol = `gateway-v1.${Buffer.from(token).toString("base64url")}`;
    const invalidProtocol = `gateway-v1.${Buffer.from("wrong-token").toString("base64url")}`;

    await expect(webSocketHandshake(address, validProtocol)).resolves.toMatch(/^HTTP\/1\.1 101 /);
    await expect(webSocketHandshake(address, invalidProtocol)).resolves.toMatch(/^HTTP\/1\.1 401 /);

    await app.close();
    store.close();
  });

  it("normalizes a Codex Session startup failure without exposing provider details", async () => {
    const { store, provider, gateway } = await createGateway();
    provider.startSessionFailure = new Error("Codex App Server exited.");
    const project = gateway.createProject("workspace", process.cwd());
    const app = await buildApp({ config, gateway });
    const response = await app.inject({
      method: "POST", url: "/sessions", headers: { authorization: `Bearer ${token}` },
      payload: { providerId: "codex", projectId: project.id },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "PROVIDER_UNAVAILABLE", message: "Codex App Server could not start the session." } });
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

  it("never exposes provider-native IDs from the mobile Session response", async () => {
    const { store, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const app = await buildApp({ config, gateway });
    const response = await app.inject({
      method: "POST", url: "/sessions", headers: { authorization: `Bearer ${token}` },
      payload: { providerId: "codex", projectId: project.id },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty("providerSessionId");
    await app.close();
    store.close();
  });

});
