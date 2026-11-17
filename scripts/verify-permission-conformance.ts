import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { filesystemProbeResult } from "./conformance-probe.js";
import { fixtureWriteCommand } from "./conformance-command.js";

// Real Codex App Server; no remote inference or credentials. --enforcement writes only fixture markers.
const enforcement = process.argv.includes("--enforcement");
const windowsReadiness = process.argv.includes("--windows-readiness");
const permissionKind = process.argv.find((value) => value.startsWith("--permissions="))?.split("=")[1] ?? "mixed";
assert(["mixed", "filesystem"].includes(permissionKind), "Invalid permission kind");
const windowsSandbox = process.argv.find((value) => value.startsWith("--windows-sandbox="))?.split("=")[1];
if (windowsSandbox) assert(["mxc", "elevated", "unelevated"].includes(windowsSandbox), "Invalid Windows sandbox mode");
const setupSandbox = process.argv.includes("--setup-sandbox");
assert(process.platform === "win32" || (!windowsSandbox && !windowsReadiness && !setupSandbox), "Windows sandbox options require Windows");
assert(!setupSandbox || windowsSandbox, "Sandbox setup requires an explicit Windows sandbox mode");
assert(!setupSandbox || windowsSandbox !== "mxc", "MXC requires no legacy setup");
assert(!windowsReadiness || (!setupSandbox && !enforcement), "Readiness is a read-only diagnostic; do not combine it with setup or enforcement");
const directory = await mkdtemp(join(tmpdir(), "gateway-permission-conformance-"));
assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
const targetDirectory = join(directory, "scope-target"); await mkdir(targetDirectory);
let call = 0;
let output: any;
let permissionOutput: any;
let toolPresent = false;
let toolStage: "request" | "command" | "done" = "request";
let marker = "";
let commandApprovals = 0;
const consumed = new Set<number>();
const server = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const tools = (input.tools || []).flatMap((tool: any) => tool.type === "namespace" ? tool.tools : [tool]);
  toolPresent ||= tools.some((tool: any) => tool.name === "request_permissions");
  const result = consumed.has(call) ? undefined : input.input?.findLast((item: any) => item.type === "function_call_output" && item.call_id === `call_${call}`);
  if (result) { output = result.output; consumed.add(call); }
  if (result && toolStage === "request") { permissionOutput = typeof output === "string" ? JSON.parse(output) : output; toolStage = enforcement ? "command" : "done"; }
  else if (result && toolStage === "command") toolStage = "done";
  const item = toolStage === "done" ? {
    type: "message", id: `msg_${call}`, role: "assistant", content: [{ type: "output_text", text: "fixture complete" }],
  } : {
    type: "function_call", id: `fc_${++call}`, call_id: `call_${call}`, name: toolStage === "request" ? "request_permissions" : "exec_command",
    arguments: JSON.stringify(toolStage === "request"
      ? { permissions: { ...(permissionKind === "mixed" ? { network: { enabled: true } } : {}), file_system: { write: [targetDirectory] } }, reason: "Gateway conformance only" }
      : { ...fixtureWriteCommand(marker, true), yield_time_ms: 1000, max_output_tokens: 500 }),
  };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${call}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory };
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "ACCESS_TOKEN"]) delete environment[key];
const child = spawn(process.env.CODEX_CONFORMANCE_COMMAND || "codex", [
  "app-server", "--stdio", "-c", 'model_provider="gateway_fixture"', "-c", 'model="gpt-5.4"',
  "-c", 'model_providers.gateway_fixture.name="Gateway Fixture"',
  "-c", `model_providers.gateway_fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
  "-c", 'model_providers.gateway_fixture.wire_api="responses"',
  "-c", "model_providers.gateway_fixture.requires_openai_auth=false",
  "-c", "model_providers.gateway_fixture.supports_websockets=false",
  "-c", "features.request_permissions_tool=true",
  ...(windowsSandbox ? ["-c", `windows.sandbox="${windowsSandbox}"`] : []),
], { env: environment, windowsHide: true, stdio: "pipe" });
const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let id = 0, buffer = "", approvals = 0, resolved = 0, turnCount = 0;
let grant: "turn" | "session" | "deny" | "interrupt" = "deny";
let complete: ((value: any) => void) | undefined;
let setupComplete: ((value: boolean) => void) | undefined;
let stopped = false;
const fail = () => {
  stopped = true;
  for (const request of pending.values()) request.reject(new Error("Conformance process unavailable."));
  pending.clear(); complete?.({ status: "failed" }); setupComplete?.(false);
};
child.once("error", fail); child.once("exit", fail);
const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
  if (stopped) { reject(new Error("Conformance process unavailable.")); return; }
  const key = String(++id); pending.set(key, { resolve, reject }); send({ id: key, method, params });
});
child.stdout.setEncoding("utf8"); child.stderr.on("data", () => undefined);
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const request = pending.get(String(message.id));
    if (request && !message.method) {
      pending.delete(String(message.id));
      if (message.error) request.reject(new Error("Conformance RPC failed: " + message.error.code));
      else request.resolve(message.result);
    } else if (message.method === "item/permissions/requestApproval") {
      approvals++;
      if (grant === "interrupt") void rpc("turn/interrupt", { threadId: message.params.threadId, turnId: message.params.turnId }).catch(fail);
      else send({ id: message.id, result: { permissions: grant === "deny" ? {} : message.params.permissions, scope: grant === "session" ? "session" : "turn" } });
    } else if (message.method === "serverRequest/resolved") resolved++;
    else if (message.method === "item/commandExecution/requestApproval") {
      commandApprovals++;
      const offered = message.params.availableDecisions;
      const decision = !Array.isArray(offered) || offered.includes("decline") ? "decline" : "cancel";
      send({ id: message.id, result: { decision } });
    }
    else if (message.method === "turn/completed") complete?.(message.params.turn);
    else if (message.method === "windowsSandbox/setupCompleted") {
      console.log(JSON.stringify({ phase: "sandbox-setup", mode: message.params.mode, success: message.params.success }));
      setupComplete?.(message.params.success === true);
    }
  }
});
const deadline = setTimeout(() => { fail(); child.kill(); console.error("Permission conformance timed out"); process.exitCode = 1; }, setupSandbox ? 120000 : 45000);
const thread = async () => (await rpc("thread/start", { cwd: directory, ephemeral: true, approvalPolicy: "on-request", sandbox: "read-only" })).thread.id;
const turn = async (threadId: string, probe = false) => {
  toolStage = probe ? "command" : "request"; marker = join(targetDirectory, `marker-${++turnCount}.txt`);
  output = undefined; permissionOutput = undefined; commandApprovals = 0; const completed = new Promise<any>((resolve) => { complete = resolve; });
  await rpc("turn/start", { threadId, input: [{ type: "text", text: `Fixture turn ${call + 1}. No command execution.` }] });
  const result = await completed; complete = undefined;
  if (!enforcement || commandApprovals === 0) assert.equal(result.status, grant === "interrupt" ? "interrupted" : "completed");
  let wrote = false; try { await access(marker); wrote = true; } catch { /* denied write */ }
  return { wrote, commandApprovals, commandOutput: output, permissionOutput };
};
const filesystemResults: { decision: string; phase: string; result: string; verified: boolean }[] = [];
function verifyWrite(result: Awaited<ReturnType<typeof turn>>, expected: boolean, phase: string) {
  const evidence = filesystemProbeResult(result.commandOutput, result.commandApprovals, result.wrote, expected);
  const entry = { decision: grant, phase, result: evidence, verified: evidence === "verified" };
  filesystemResults.push(entry);
  console.log(JSON.stringify({ ...entry, check: "filesystem-enforcement", expectedWrite: expected, wrote: result.wrote, networkVerified: false }));
}
async function verify() {
  await rpc("initialize", { clientInfo: { name: "gateway-conformance", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  if (windowsReadiness) {
    const readiness = await rpc("windowsSandbox/readiness");
    assert(["ready", "notConfigured", "updateRequired"].includes(readiness.status), "Unknown Windows sandbox readiness status");
    console.log(JSON.stringify({ phase: "windows-readiness", status: readiness.status, setupPerformed: false }));
    return;
  }
  if (setupSandbox) {
    const setupResult = new Promise<boolean>((resolve) => { setupComplete = resolve; });
    await rpc("windowsSandbox/setupStart", { mode: windowsSandbox });
    assert(await setupResult, "Windows sandbox setup did not complete successfully.");
    setupComplete = undefined;
  }
  for (const decision of ["deny", "turn", "session"] as const) {
    grant = decision; const sessionId = await thread(); let before = approvals;
    const first = await turn(sessionId);
    assert(toolPresent); assert.equal(approvals - before, 1);
    const profile = first.permissionOutput?.permissions;
    assert.equal(profile?.network?.enabled === true, decision !== "deny" && permissionKind === "mixed");
    assert.equal(first.permissionOutput?.scope, decision === "session" ? "session" : "turn");
    if (decision === "deny") assert.equal(profile?.file_system ?? null, null);
    else assert.deepEqual(profile?.file_system?.write, [targetDirectory]);
    console.log(JSON.stringify({ decision, phase: "first-turn", scope: first.permissionOutput?.scope, exactPermissions: true }));
    if (enforcement) verifyWrite(first, decision !== "deny", "first-turn");
    before = approvals; const next = await turn(sessionId, enforcement);
    assert.equal(approvals - before, enforcement ? 0 : 1);
    if (enforcement) verifyWrite(next, decision === "session", "next-turn");
    console.log(JSON.stringify({ decision, phase: "next-turn", protocolVerified: true, enforcementVerified: enforcement && filesystemResults.at(-1)?.verified === true }));
    before = approvals; const other = await turn(await thread(), enforcement);
    assert.equal(approvals - before, enforcement ? 0 : 1);
    if (enforcement) verifyWrite(other, false, "other-session");
    console.log(JSON.stringify({ decision, phase: "other-session", protocolVerified: true, enforcementVerified: enforcement && filesystemResults.at(-1)?.verified === true }));
  }
  grant = "interrupt"; const before = resolved; await turn(await thread());
  console.log(JSON.stringify({ phase: "interrupt", runInterrupted: true, resolvedNotification: resolved > before }));
  const filesystemVerified = enforcement && filesystemResults.length === 9 && filesystemResults.every((entry) => entry.verified);
  console.log(JSON.stringify({ phase: "summary", permissionKind, windowsSandbox: windowsSandbox ?? "default", protocolVerified: true,
    filesystemVerified, networkVerified: false, filesystemResults }));
  if (enforcement && !filesystemVerified) process.exitCode = 1;
}
try {
  await verify();
} finally {
  clearTimeout(deadline); child.stdin.end();
  const shutdown = setTimeout(() => child.kill(), 2000); await exited; clearTimeout(shutdown);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
