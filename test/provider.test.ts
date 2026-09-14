import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayService } from "../src/gateway.js";
import { CodexProvider, JsonRpcProcess } from "../src/provider.js";
import { GatewayStore } from "../src/store.js";
import type { ProviderEvent } from "../src/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const fakeServer = join(fixtures, "fake-app-server.mjs");
const resolvedFixture = join(fixtures, "server-request-resolved.json");
const providers: CodexProvider[] = [];
const transports: JsonRpcProcess[] = [];
const stores: GatewayStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createProvider(requestFixture: string, responseFixture: string): CodexProvider {
  const provider = new CodexProvider({
    codexCommand: process.execPath,
    codexArgs: [fakeServer, join(fixtures, requestFixture), responseFixture === "error" ? responseFixture : join(fixtures, responseFixture), resolvedFixture],
  });
  providers.push(provider);
  return provider;
}

function nextEvent(provider: CodexProvider, type: ProviderEvent["type"]): Promise<ProviderEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 3_000);
    const unsubscribe = provider.onEvent((event) => {
      if (event.type !== type) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

async function startApprovalRun(provider: CodexProvider): Promise<ProviderEvent> {
  const requested = nextEvent(provider, "approvalRequested");
  const sessionId = await provider.startSession("C:\\workspace");
  expect(sessionId).toBe("thread_fixture");
  await expect(provider.startRun(sessionId, "trigger fixture approval")).resolves.toEqual({ providerRunId: "turn_fixture" });
  return requested;
}

describe("CodexProvider approval boundary", () => {
  it("normalizes a command request, filters policy amendments, and responds exactly once", async () => {
    const provider = createProvider("command-approval-request.json", "command-approval-response.json");
    const event = await startApprovalRun(provider);
    expect(event).toMatchObject({
      type: "approvalRequested",
      approval: {
        type: "command",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        details: { type: "command", kind: "command", command: "npm test", cwd: "C:\\workspace" },
        binding: {
          providerRequestId: "request_command_fixture",
          connectionGeneration: 1,
          providerSessionId: "thread_fixture",
          providerRunId: "turn_fixture",
          providerItemId: "item_command_fixture",
          providerApprovalId: "approval_command_fixture",
        },
      },
    });
    if (event.type !== "approvalRequested") throw new Error("Expected approvalRequested.");
    const resolved = nextEvent(provider, "approvalResolved");
    await provider.respondToApproval(event.approval.binding, "accept");
    await expect(resolved).resolves.toMatchObject({ type: "approvalResolved", approval: { type: "command" } });
    await expect(provider.respondToApproval(event.approval.binding, "accept")).rejects.toThrow("no longer pending");
  });

  it("uses conservative defaults for file changes when availableDecisions is absent", async () => {
    const provider = createProvider("file-change-approval-request.json", "file-change-approval-response.json");
    const event = await startApprovalRun(provider);
    expect(event).toMatchObject({
      type: "approvalRequested",
      approval: {
        type: "fileChange",
        availableDecisions: ["accept", "decline", "cancel"],
        details: { type: "fileChange", grantRoot: "C:\\workspace" },
      },
    });
    if (event.type !== "approvalRequested") throw new Error("Expected approvalRequested.");
    await expect(provider.respondToApproval(event.approval.binding, "acceptForSession")).rejects.toThrow("not available");
    const resolved = nextEvent(provider, "approvalResolved");
    await provider.respondToApproval(event.approval.binding, "accept");
    await expect(resolved).resolves.toMatchObject({ type: "approvalResolved", approval: { type: "fileChange" } });
  });

  it("keeps permission approval disabled and can fail it closed with an error response", async () => {
    const provider = createProvider("permission-approval-request.json", "error");
    const event = await startApprovalRun(provider);
    expect(provider.capabilities.permissionApproval).toBe(false);
    expect(event).toMatchObject({
      type: "approvalRequested",
      approval: {
        type: "permission",
        availableDecisions: [],
        details: { type: "permission", cwd: "C:\\workspace", permissions: { network: { enabled: true } } },
      },
    });
    if (event.type !== "approvalRequested") throw new Error("Expected approvalRequested.");
    await expect(provider.respondToApproval(event.approval.binding, "accept")).rejects.toThrow("Permission approval is not supported");
    const resolved = nextEvent(provider, "approvalResolved");
    await provider.rejectApproval(event.approval.binding);
    await expect(resolved).resolves.toMatchObject({ type: "approvalResolved", approval: { type: "permission" } });
  });

  it("rejects a response handle from an earlier App Server connection", async () => {
    const transport = new JsonRpcProcess(process.execPath, [
      fakeServer,
      join(fixtures, "command-approval-request.json"),
      join(fixtures, "command-approval-response.json"),
      resolvedFixture,
    ]);
    transports.push(transport);
    await transport.start();
    const staleGeneration = transport.connectionGeneration;
    await transport.close();
    await transport.start();
    expect(transport.connectionGeneration).toBe(staleGeneration + 1);
    await expect(transport.respondResult("request_command_fixture", staleGeneration, { decision: "accept" }))
      .rejects.toThrow("unavailable connection");
  });

  it("does not lose an approval batched with the turn/start response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-gateway-provider-"));
    temporaryDirectories.push(directory);
    const store = new GatewayStore(directory);
    stores.push(store);
    const provider = createProvider("command-approval-request.json", "error");
    const gateway = new GatewayService(store, provider);
    const project = gateway.createProject("workspace", process.cwd());
    const session = await gateway.startSession(project.id);
    const resolved = nextEvent(provider, "approvalResolved");

    const run = await gateway.startRun(session.id, "trigger fixture approval");

    await expect(resolved).resolves.toMatchObject({ type: "approvalResolved", approval: { type: "command" } });
    expect(run.status).toBe("Failed");
    expect(gateway.listEvents(session.id).map((event) => event.type)).toEqual([
      "session.started",
      "run.started",
      "agent.status",
      "error",
    ]);
    expect(gateway.listEvents(session.id).at(-1)?.payload).toMatchObject({ code: "APPROVAL_UNSUPPORTED" });
  });
});
