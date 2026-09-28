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
import type { ApprovalDecision, ProviderApprovalBinding, ProviderCapabilities, ProviderEvent } from "../src/types.js";

class FakeProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    resumableSessions: true, eventStreaming: true, interruptRun: true,
    commandApproval: true, fileChangeApproval: true, permissionApproval: false, workspaceAccess: true,
  };
  private listeners = new Set<(event: ProviderEvent) => void>();
  startSessionFailure?: Error;
  approvalResponseFailure?: Error;
  approvalResponses: { binding: ProviderApprovalBinding; decision: ApprovalDecision }[] = [];
  rejectedApprovals: ProviderApprovalBinding[] = [];
  async startSession(): Promise<string> {
    if (this.startSessionFailure) throw this.startSessionFailure;
    return "thread_fake";
  }
  async resumeSession(): Promise<void> {}
  async startRun(): Promise<StartRunResult> { return { providerRunId: "turn_fake" }; }
  async interruptRun(): Promise<void> {}
  async respondToApproval(binding: ProviderApprovalBinding, decision: ApprovalDecision): Promise<void> {
    if (this.approvalResponseFailure) throw this.approvalResponseFailure;
    this.approvalResponses.push({ binding, decision });
  }
  async rejectApproval(binding: ProviderApprovalBinding): Promise<void> { this.rejectedApprovals.push(binding); }
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
  return { directory, store, provider, gateway: new GatewayService(store, provider) };
}

function commandApprovalEvent(details: Partial<Extract<ProviderEvent, { type: "approvalRequested" }>["approval"]["details"]> = {}): Extract<ProviderEvent, { type: "approvalRequested" }> {
  return {
    type: "approvalRequested",
    providerSessionId: "thread_fake",
    providerRunId: "turn_fake",
    approval: {
      type: "command",
      binding: {
        providerRequestId: "request_fake",
        providerConnectionId: "connection_fake",
        connectionGeneration: 1,
        providerSessionId: "thread_fake",
        providerRunId: "turn_fake",
        providerItemId: "item_fake",
      },
      availableDecisions: ["accept", "decline", "cancel"],
      details: { type: "command", kind: "command", command: "test", ...details },
    },
  };
}

function fileApprovalEvent(grantRoot = process.cwd()): Extract<ProviderEvent, { type: "approvalRequested" }> {
  return {
    type: "approvalRequested",
    providerSessionId: "thread_fake",
    providerRunId: "turn_fake",
    approval: {
      type: "fileChange",
      binding: {
        providerRequestId: "request_file",
        providerConnectionId: "connection_fake",
        connectionGeneration: 1,
        providerSessionId: "thread_fake",
        providerRunId: "turn_fake",
        providerItemId: "item_file",
      },
      availableDecisions: ["accept", "decline", "cancel"],
      details: { type: "fileChange", grantRoot, reason: "apply requested changes" },
    },
  };
}

const settleEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  it("persists a provider approval request without deciding it automatically", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "needs approval");
    provider.emit(commandApprovalEvent());
    await settleEvents();

    expect(store.getRun(run.id).status).toBe("Running");
    expect(provider.approvalResponses).toHaveLength(0);
    expect(provider.rejectedApprovals).toHaveLength(0);
    expect(gateway.listApprovals({ sessionId: session.id, status: "Pending" })).toHaveLength(1);
    expect(gateway.listEvents(session.id).slice(-2).map((event) => event.type)).toEqual(["approval.requested", "agent.status"]);
    store.close();
  });

  it("fails closed for permission approval while that capability is disabled", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "needs permission");
    provider.emit({
      type: "approvalRequested",
      providerSessionId: "thread_fake",
      providerRunId: "turn_fake",
      approval: {
        type: "permission",
        binding: {
          providerRequestId: "request_permission",
          providerConnectionId: "connection_fake",
          connectionGeneration: 1,
          providerSessionId: "thread_fake",
          providerRunId: "turn_fake",
          providerItemId: "item_permission",
        },
        availableDecisions: [],
        details: { type: "permission", cwd: process.cwd(), permissions: { network: { enabled: true } } },
      },
    });
    await settleEvents();

    expect(store.getRun(run.id).status).toBe("Failed");
    expect(provider.rejectedApprovals).toHaveLength(1);
    expect(gateway.listApprovals({ sessionId: session.id })).toHaveLength(0);
    expect(gateway.listEvents(session.id).at(-1)?.payload).toMatchObject({ code: "APPROVAL_UNSUPPORTED" });
    store.close();
  });

  it("rejects an approval whose Provider binding does not match the active Run", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "invalid approval");
    const event = commandApprovalEvent();
    event.approval.binding.providerRunId = "turn_other";
    provider.emit(event);
    await settleEvents();

    expect(provider.rejectedApprovals).toHaveLength(1);
    expect(gateway.listApprovals({ sessionId: session.id })).toHaveLength(0);
    expect(store.getRun(run.id).status).toBe("Failed");
    expect(gateway.listEvents(session.id).at(-1)?.payload).toEqual({
      code: "INVALID_APPROVAL",
      message: "The approval request did not match the active Run.",
    });
    store.close();
  });

  it("claims a decision once, sends only the internal binding, and resolves on Provider confirmation", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "needs approval");
    const requestedEvent = commandApprovalEvent();
    provider.emit(requestedEvent);
    await settleEvents();
    const approval = gateway.listApprovals({ sessionId: session.id, status: "Pending" })[0]!;

    const decided = await gateway.decideApproval(approval.id, "decline");

    expect(decided.status).toBe("Declined");
    expect(provider.approvalResponses).toEqual([{ binding: requestedEvent.approval.binding, decision: "decline" }]);
    await expect(gateway.decideApproval(approval.id, "accept")).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    provider.emit({
      type: "approvalResolved",
      providerSessionId: "thread_fake",
      providerRunId: "turn_fake",
      approval: requestedEvent.approval,
    });
    await settleEvents();

    expect(gateway.getApproval(approval.id)).toMatchObject({ status: "Resolved", resolutionReason: "PROVIDER_RESOLVED" });
    const resolvedEvent = gateway.listEvents(session.id).find((event) => event.type === "approval.resolved");
    expect(resolvedEvent?.payload).toEqual({
      approvalId: approval.id,
      status: "Resolved",
      resolutionReason: "PROVIDER_RESOLVED",
    });
    expect(JSON.stringify(resolvedEvent)).not.toContain("request_fake");
    store.close();
  });

  it("normalizes and delivers a File Change decision through the same Gateway contract", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "change a file");
    const requestedEvent = fileApprovalEvent();
    provider.emit(requestedEvent);
    await settleEvents();
    const approval = gateway.listApprovals({ sessionId: session.id, status: "Pending" })[0]!;

    expect(approval).toMatchObject({ type: "fileChange", display: { type: "fileChange", grantRoot: "." } });
    await gateway.decideApproval(approval.id, "cancel");

    expect(provider.approvalResponses).toEqual([{ binding: requestedEvent.approval.binding, decision: "cancel" }]);
    store.close();
  });

  it("keeps the Run waiting while another Approval is still Pending", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "two approvals");
    const first = commandApprovalEvent();
    const second = fileApprovalEvent();
    provider.emit(first);
    provider.emit(second);
    await settleEvents();
    const approvals = gateway.listApprovals({ sessionId: session.id, status: "Pending" });

    await gateway.decideApproval(approvals[0]!.id, approvals[0]!.availableDecisions[0]!);

    expect(gateway.listEvents(session.id).at(-1)).toMatchObject({
      type: "agent.status",
      payload: { status: "WaitingApproval" },
    });
    store.close();
  });

  it("resolves Pending approvals before publishing terminal Run completion", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "needs approval");
    provider.emit(commandApprovalEvent());
    await settleEvents();

    provider.emit({ type: "runCompleted", providerSessionId: "thread_fake", providerRunId: "turn_fake", status: "completed" });
    await settleEvents();

    expect(gateway.listApprovals({ sessionId: session.id })[0]).toMatchObject({
      status: "Resolved",
      resolutionReason: "RUN_COMPLETED",
    });
    const finalEvents = gateway.listEvents(session.id).slice(-2);
    expect(finalEvents.map((event) => event.type)).toEqual(["approval.resolved", "run.completed"]);
    expect(store.getRun(run.id).status).toBe("Completed");
    store.close();
  });

  it("closes a Pending approval when the Provider resolves it first", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "provider resolves first");
    const requestedEvent = commandApprovalEvent();
    provider.emit(requestedEvent);
    await settleEvents();
    const approval = gateway.listApprovals({ sessionId: session.id, status: "Pending" })[0]!;

    provider.emit({
      type: "approvalResolved",
      providerSessionId: "thread_fake",
      providerRunId: "turn_fake",
      approval: requestedEvent.approval,
    });
    await settleEvents();

    expect(gateway.getApproval(approval.id)).toMatchObject({ status: "Resolved", resolutionReason: "PROVIDER_RESOLVED" });
    await expect(gateway.decideApproval(approval.id, "accept")).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    store.close();
  });

  it("resolves stale Pending approvals on Gateway restart without replaying Provider request IDs", async () => {
    const { directory, store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "restart while pending");
    provider.emit(commandApprovalEvent());
    await settleEvents();
    const approval = gateway.listApprovals({ sessionId: session.id, status: "Pending" })[0]!;
    store.close();

    const recoveredStore = new GatewayStore(directory);
    const recoveredProvider = new FakeProvider();
    const recoveredGateway = new GatewayService(recoveredStore, recoveredProvider);

    expect(recoveredGateway.getApproval(approval.id)).toMatchObject({
      status: "Resolved",
      resolutionReason: "PROVIDER_APPROVAL_UNAVAILABLE",
    });
    await expect(recoveredGateway.decideApproval(approval.id, "accept")).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(recoveredProvider.approvalResponses).toHaveLength(0);
    expect(recoveredGateway.listEvents(session.id).at(-1)?.type).toBe("approval.resolved");
    recoveredStore.close();
  });

  it("resolves the claim and fails the Run when the Provider response cannot be delivered", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const run = await gateway.startRun(session.id, "needs approval");
    provider.emit(commandApprovalEvent());
    await settleEvents();
    const approval = gateway.listApprovals({ sessionId: session.id, status: "Pending" })[0]!;
    provider.approvalResponseFailure = new Error("Bearer secret C:\\Users\\private");

    await expect(gateway.decideApproval(approval.id, "accept")).rejects.toMatchObject({
      statusCode: 503,
      code: "PROVIDER_UNAVAILABLE",
    });

    expect(gateway.getApproval(approval.id)).toMatchObject({
      status: "Resolved",
      resolutionReason: "PROVIDER_RESPONSE_FAILED",
    });
    expect(store.getRun(run.id).status).toBe("Failed");
    expect(JSON.stringify(gateway.listEvents(session.id))).not.toContain("secret");
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
    expect(response.body).toContain("Codex 답변");
    expect(response.body).toContain("agent.message.delta");
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

  it("lists and decides approvals without exposing Provider IDs or sensitive display text", async () => {
    const { store, provider, gateway } = await createGateway();
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    await gateway.startRun(session.id, "needs approval");
    const requestedEvent = commandApprovalEvent({
      command: `npm --token supersecret --prefix "${process.cwd()}" test`,
      cwd: join(process.cwd(), "src"),
      reason: "Authorization: Bearer topsecret\nneeds access",
    });
    provider.emit(requestedEvent);
    await settleEvents();
    const app = await buildApp({ config, gateway });
    const authorization = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/approvals" })).statusCode).toBe(401);
    const listResponse = await app.inject({
      method: "GET",
      url: `/approvals?sessionId=${session.id}&status=Pending`,
      headers: authorization,
    });
    expect(listResponse.statusCode).toBe(200);
    const approvals = listResponse.json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      type: "command",
      status: "Pending",
      itemId: expect.stringMatching(/^itm_[a-f0-9]{32}$/),
      display: { type: "command", kind: "command", cwd: "src" },
    });
    expect(JSON.stringify(approvals)).not.toMatch(/request_fake|connection_fake|thread_fake|turn_fake|supersecret|topsecret/i);
    expect(JSON.stringify(approvals)).not.toContain(process.cwd());
    const getResponse = await app.inject({
      method: "GET",
      url: `/approvals/${approvals[0].id}`,
      headers: authorization,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(approvals[0]);

    const invalidResponse = await app.inject({
      method: "POST",
      url: `/approvals/${approvals[0].id}/decision`,
      headers: authorization,
      payload: { decision: "approveEverything" },
    });
    expect(invalidResponse.statusCode).toBe(400);
    const unavailableResponse = await app.inject({
      method: "POST",
      url: `/approvals/${approvals[0].id}/decision`,
      headers: authorization,
      payload: { decision: "acceptForSession" },
    });
    expect(unavailableResponse.statusCode).toBe(400);

    const decisionResponse = await app.inject({
      method: "POST",
      url: `/approvals/${approvals[0].id}/decision`,
      headers: authorization,
      payload: { decision: "decline" },
    });
    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json()).toMatchObject({ id: approvals[0].id, status: "Declined" });
    expect(provider.approvalResponses).toEqual([{ binding: requestedEvent.approval.binding, decision: "decline" }]);

    await app.close();
    store.close();
  });

});
