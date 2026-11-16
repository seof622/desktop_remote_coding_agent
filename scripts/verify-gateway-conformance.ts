import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../src/app.js";
import { GatewayService } from "../src/gateway.js";
import { CodexProvider } from "../src/provider.js";
import { GatewayStore } from "../src/store.js";
import type { AgentEvent, Approval } from "../src/types.js";

// Real App Server + application HTTP/WebSocket boundary; inference stays on loopback.
// Never accept command/file approvals, change OS policy, or read the user's Codex home.
const directory = await mkdtemp(join(tmpdir(), "gateway-runtime-conformance-"));
assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
const workspace = join(directory, "workspace");
const target = join(directory, "scope-target", "marker.txt");
await mkdir(workspace);
await mkdir(dirname(target));
const codexHome = join(directory, "codex-home");
await mkdir(codexHome);
process.env.CODEX_HOME = codexHome;
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "ACCESS_TOKEN"]) delete process.env[key];

let mode: "command" | "fileChange" | "permission" = "command";
let call = 0;
let activeCall = "";
let issued = false;
let fixtureFailure = false;
let toolResult = "";
let patchToolAvailable = false;
const fixture = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const tools = (input.tools || []).flatMap((tool: { type?: string; tools?: unknown[] }) => tool.type === "namespace" ? tool.tools : [tool]);
    patchToolAvailable ||= tools.some((tool: { name?: string }) => tool.name === "apply_patch");
    const result = input.input?.some((item: { call_id?: string; type?: string }) => item.call_id === activeCall
      && ["function_call_output", "custom_tool_call_output"].includes(item.type ?? ""));
    if (result) toolResult = JSON.stringify(input.input.findLast((item: { call_id?: string }) => item.call_id === activeCall)?.output);
    const id = ++call;
    const item = issued && result ? {
      type: "message", id: `msg_${id}`, role: "assistant",
      content: [{ type: "output_text", text: "fixture complete" }],
    } : (() => {
      assert(!issued, "Fixture unexpectedly repeated an inference request.");
      issued = true;
      activeCall = `call_${id}`;
      if (mode === "fileChange") return {
        type: "custom_tool_call", id: `tool_${id}`, call_id: activeCall, name: "apply_patch",
        input: `*** Begin Patch\n*** Add File: ${target.replaceAll("\\", "/")}\n+fixture\n*** End Patch`,
      };
      return {
        type: "function_call", id: `fc_${id}`, call_id: activeCall,
        name: mode === "permission" ? "request_permissions" : "exec_command",
        arguments: JSON.stringify(mode === "permission"
          ? { permissions: { file_system: { write: [dirname(target)] }, network: { enabled: true } }, reason: "Gateway fixture" }
          : { cmd: `Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value fixture`, shell: "powershell", login: false, max_output_tokens: 100 }),
      };
    })();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
  } catch {
    fixtureFailure = true;
    response.writeHead(500).end();
  }
});
await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
const fixtureAddress = fixture.address();
assert(fixtureAddress && typeof fixtureAddress !== "string");
const config = {
  clientToken: randomBytes(32).toString("base64url"), bindHost: "127.0.0.1", port: 0,
  dataDir: join(directory, "data"), workspaceRoots: [workspace],
  codexCommand: process.env.CODEX_CONFORMANCE_COMMAND || "codex",
  codexArgs: ["app-server", "--stdio", "-c", 'model_provider="gateway_fixture"', "-c", 'model="gpt-6.1-sol"',
    "-c", 'model_providers.gateway_fixture.name="Gateway Fixture"',
    "-c", `model_providers.gateway_fixture.base_url="http://127.0.0.1:${fixtureAddress.port}/v1"`,
    "-c", 'model_providers.gateway_fixture.wire_api="responses"',
    "-c", "model_providers.gateway_fixture.requires_openai_auth=false",
    "-c", "model_providers.gateway_fixture.supports_websockets=false",
    "-c", "features.request_permissions_tool=true", "-c", "features.apply_patch_freeform=true",
    "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "-c", "sandbox_workspace_write.exclude_slash_tmp=true"],
};
let store = new GatewayStore(config.dataDir);
let provider = new CodexProvider(config);
let gateway = new GatewayService(store, provider);
let app = await buildApp({ config, gateway });
let address = await app.listen({ host: config.bindHost, port: 0 });
const sockets = new Set<WebSocket>();
const protocol = `gateway-v1.${Buffer.from(config.clientToken).toString("base64url")}`;
const abort = new AbortController();
const coverage = { commandCancel: false, commandDecline: false, unavailableDecisionRejected: false, fileChange: false,
  pendingInterrupt: false, permissionFailClosed: false, restartRecovery: false };

async function http(method: string, url: string, payload?: unknown, status = 200) {
  const response = await fetch(address + url, {
    method, headers: { authorization: `Bearer ${config.clientToken}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
  });
  assert.equal(response.status, status, `Unexpected HTTP status for ${method} ${url.split("/")[1]}`);
  return response.json();
}
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!check()) {
    abort.signal.throwIfAborted();
    assert(!fixtureFailure, "Loopback fixture failed.");
    assert(Date.now() < end, `Timed out: ${label}`);
    await delay(20);
  }
}
async function connect(sessionId: string, afterSequence = 0) {
  const events: AgentEvent[] = [];
  const socket = new WebSocket(`${address.replace("http:", "ws:")}/events?sessionId=${sessionId}&afterSequence=${afterSequence}`, protocol);
  sockets.add(socket);
  socket.addEventListener("message", (message) => events.push(JSON.parse(String(message.data))));
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Fixture WebSocket timed out.")); }, 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); done(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Fixture WebSocket failed.")); }, { once: true });
  });
  return { socket, events };
}
async function closeSockets() {
  await Promise.all([...sockets].map((socket) => new Promise<void>((done) => {
    if (socket.readyState === WebSocket.CLOSED) { done(); return; }
    socket.addEventListener("close", () => done(), { once: true });
    socket.close();
  })));
  sockets.clear();
}
function privateDataAbsent(value: unknown, sessionId: string) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes(config.clientToken), "Client token leaked.");
  assert(!serialized.includes(store.getSession(sessionId).providerSessionId), "Provider session ID leaked.");
  assert(!serialized.includes(directory) && !serialized.includes(directory.replaceAll("\\", "\\\\")), "Fixture path leaked.");
  assert(!/providerRequestId|providerRunId|providerConnectionId/.test(serialized), "Provider binding leaked.");
}
async function start(projectId: string, selected: typeof mode) {
  mode = selected; issued = false; activeCall = ""; toolResult = "";
  const session = await http("POST", "/sessions", { projectId, providerId: "codex" }, 201);
  const stream = await connect(session.id);
  const run = await http("POST", `/sessions/${session.id}/runs`, { text: "Run the deterministic local fixture." }, 201);
  return { session, run, ...stream };
}

const deadline = setTimeout(() => {
  abort.abort(new Error("Gateway conformance timed out."));
  void provider.close();
  for (const socket of sockets) socket.close();
  fixture.closeAllConnections();
}, 90_000);
try {
  assert.equal((await fetch(address + "/approvals")).status, 401);
  const project = await http("POST", "/projects", { name: "fixture", workspacePath: workspace }, 201);
  for (const type of ["command", "fileChange"] as const) {
    for (const decision of ["decline", "cancel"] as const) {
      const { session, run, events } = await start(project.id, type);
      await until(() => gateway.listApprovals({ sessionId: session.id, status: "Pending" }).length === 1
        || ["Completed", "Failed", "Interrupted"].includes(store.getRun(run.id).status), `${type} approval`);
      const approvals: Approval[] = await http("GET", `/approvals?sessionId=${session.id}&status=Pending`);
      if (approvals.length === 0 && type === "fileChange") {
        await assert.rejects(access(target));
        console.log(JSON.stringify({ type, approvalVerified: false, patchToolAvailable, markerAbsent: true,
          toolRejected: /rejected|not allowed|denied|Unknown tool/i.test(toolResult), runStatus: store.getRun(run.id).status }));
        await closeSockets();
        break;
      }
      const approval = approvals[0]!;
      assert.equal(approval.type, type);
      const offered = approval.availableDecisions.includes(decision);
      const selected = offered ? decision : "cancel";
      assert(approval.availableDecisions.includes(selected), "Runtime offered no safe cancellation.");
      if (!offered) await http("POST", `/approvals/${approval.id}/decision`, { decision }, 400);
      if (!offered) coverage.unavailableDecisionRejected = true;
      privateDataAbsent(approvals, session.id);
      await until(() => events.some((event) => event.type === "approval.requested"), "live approval event");
      const checkpoint = events.at(-1)!.sequence;
      await closeSockets(); // The decision and completion must be recoverable after a browser disconnect.
      await http("POST", `/approvals/${approval.id}/decision`, { decision: selected });
      await http("POST", `/approvals/${approval.id}/decision`, { decision: selected }, 409);
      await until(() => ["Completed", "Interrupted"].includes(store.getRun(run.id).status), "run termination");
      assert.equal(gateway.getApproval(approval.id).status, "Resolved");
      const replay = await connect(session.id, checkpoint);
      await until(() => replay.events.some((event) => event.type === "approval.resolved")
        && replay.events.some((event) => event.type === "run.completed"), "approval replay");
      assert(replay.events.every((event, index) => event.sequence > (replay.events[index - 1]?.sequence ?? checkpoint)));
      privateDataAbsent(replay.events, session.id);
      await assert.rejects(access(target));
      if (type === "command" && selected === "cancel") coverage.commandCancel = true;
      if (type === "command" && selected === "decline") coverage.commandDecline = true;
      if (type === "fileChange") coverage.fileChange = true;
      await closeSockets();
      console.log(JSON.stringify({ type, requestedDecision: decision, decisionOffered: offered, selectedDecision: selected,
        http: true, liveEvents: true, reconnectReplay: true, duplicateRejected: true, markerAbsent: true }));
    }
  }
  const interrupted = await start(project.id, "command");
  await until(() => gateway.listApprovals({ sessionId: interrupted.session.id, status: "Pending" }).length === 1, "interrupt approval");
  await http("POST", `/sessions/${interrupted.session.id}/interrupt`);
  await until(() => store.getRun(interrupted.run.id).status === "Interrupted", "pending interrupt");
  assert.equal(gateway.listApprovals({ sessionId: interrupted.session.id, status: "Pending" }).length, 0);
  coverage.pendingInterrupt = true;
  console.log(JSON.stringify({ phase: "pending-interrupt", runInterrupted: true, pendingCleared: true }));
  await closeSockets();

  const unsupported = await start(project.id, "permission");
  await until(() => store.getRun(unsupported.run.id).status === "Failed", "unsupported permission");
  assert.equal(provider.capabilities.permissionApproval, false);
  assert.equal(gateway.listApprovals({ sessionId: unsupported.session.id }).length, 0);
  assert(gateway.listEvents(unsupported.session.id).some((event) => event.type === "error" && event.payload.code === "APPROVAL_UNSUPPORTED"));
  privateDataAbsent(gateway.listEvents(unsupported.session.id), unsupported.session.id);
  coverage.permissionFailClosed = true;
  await closeSockets();
  console.log(JSON.stringify({ phase: "unsupported-permission", capability: false, failedClosed: true }));

  const restart = await start(project.id, "command");
  await until(() => gateway.listApprovals({ sessionId: restart.session.id, status: "Pending" }).length === 1, "restart approval");
  const stale = gateway.listApprovals({ sessionId: restart.session.id, status: "Pending" })[0]!;
  const oldConnection = store.getApprovalBinding(stale.id).providerConnectionId;
  await closeSockets(); await provider.close(); await app.close(); store.close();
  store = new GatewayStore(config.dataDir); provider = new CodexProvider(config);
  gateway = new GatewayService(store, provider); app = await buildApp({ config, gateway });
  address = await app.listen({ host: config.bindHost, port: 0 });
  assert.equal((await http("GET", `/approvals/${stale.id}`)).resolutionReason, "PROVIDER_APPROVAL_UNAVAILABLE");
  await http("POST", `/approvals/${stale.id}/decision`, { decision: "cancel" }, 409);
  const replay = await connect(restart.session.id);
  await until(() => replay.events.some((event) => event.type === "approval.resolved" && event.payload.approvalId === stale.id), "restart replay");
  privateDataAbsent(replay.events, restart.session.id);
  await closeSockets();
  const fresh = await start(project.id, "command");
  await until(() => gateway.listApprovals({ sessionId: fresh.session.id, status: "Pending" }).length === 1, "fresh connection approval");
  const freshApproval = gateway.listApprovals({ sessionId: fresh.session.id, status: "Pending" })[0]!;
  assert(store.getApprovalBinding(freshApproval.id).providerConnectionId !== oldConnection, "Restart reused the old Provider connection.");
  await http("POST", `/approvals/${freshApproval.id}/decision`, { decision: "cancel" });
  await until(() => ["Completed", "Interrupted"].includes(store.getRun(fresh.run.id).status), "fresh connection termination");
  await assert.rejects(access(target));
  coverage.restartRecovery = true;
  console.log(JSON.stringify({ phase: "gateway-restart", staleResolved: true, staleDecisionRejected: true, resolutionReplayed: true, freshConnectionVerified: true }));
  console.log(JSON.stringify({ phase: "summary", coverage, commandAcceptVerified: false, permissionEnforcementVerified: false,
    skipped: coverage.fileChange ? [] : ["file-change-approval-not-emitted-by-fixture-runtime"] }));
} finally {
  clearTimeout(deadline);
  await closeSockets(); await provider.close(); await app.close(); store.close();
  fixture.closeAllConnections(); await new Promise<void>((done) => fixture.close(() => done()));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
