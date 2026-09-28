import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayStore, type CreateApprovalInput } from "../src/store.js";

const temporaryDirectories: string[] = [];
const stores: GatewayStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(directory?: string): Promise<{ directory: string; store: GatewayStore }> {
  const dataDirectory = directory ?? await mkdtemp(join(tmpdir(), "desktop-gateway-store-"));
  if (!directory) temporaryDirectories.push(dataDirectory);
  const store = new GatewayStore(dataDirectory);
  stores.push(store);
  return { directory: dataDirectory, store };
}

function createActiveRun(store: GatewayStore, suffix = "one") {
  const project = store.createProject(`workspace-${suffix}`, join(process.cwd(), suffix));
  const session = store.createSession(project.id, `thread_${suffix}`);
  const queued = store.createRun(session.id);
  const mapped = store.setRunProviderId(queued.id, `turn_${suffix}`);
  const run = store.updateRunStatus(mapped.id, "Running");
  return { project, session, run };
}

function approvalInput(
  ownership: ReturnType<typeof createActiveRun>,
  suffix = "one",
): CreateApprovalInput {
  return {
    type: "command",
    projectId: ownership.project.id,
    sessionId: ownership.session.id,
    runId: ownership.run.id,
    itemId: `item_${suffix}`,
    availableDecisions: ["accept", "decline", "cancel"],
    display: { kind: "command", summary: `safe-${suffix}` },
    binding: {
      providerRequestId: `request_${suffix}`,
      connectionGeneration: 1,
      providerSessionId: ownership.session.providerSessionId,
      providerRunId: ownership.run.providerRunId!,
      providerItemId: `item_${suffix}`,
      providerApprovalId: `approval_${suffix}`,
    },
    requestedAt: "2026-09-28T00:00:00.000Z",
  };
}

describe("GatewayStore approvals", () => {
  it("persists a Provider-neutral Approval and idempotently upserts the same Provider request", async () => {
    const { store } = await createStore();
    const ownership = createActiveRun(store);
    const input = approvalInput(ownership);

    const created = store.upsertApproval(input);
    const duplicate = store.upsertApproval(input);

    expect(created.id).toMatch(/^apr_[a-f0-9]{32}$/);
    expect(duplicate.id).toBe(created.id);
    expect(store.listApprovals({ sessionId: ownership.session.id, status: "Pending" })).toEqual([created]);
    expect(store.getApprovalBinding(created.id)).toEqual(input.binding);
    expect(JSON.stringify(created)).not.toContain("request_one");
  });

  it("rejects reused request IDs and mismatched Project, Session, Run, or Item ownership", async () => {
    const { store } = await createStore();
    const first = createActiveRun(store, "first");
    const second = createActiveRun(store, "second");
    const input = approvalInput(first, "shared");
    store.upsertApproval(input);

    expect(() => store.upsertApproval({ ...input, runId: second.run.id }))
      .toThrow("Project, Session, and Run ownership");
    expect(() => store.upsertApproval({
      ...approvalInput(first, "wrong-run"),
      binding: { ...approvalInput(first, "wrong-run").binding, providerRunId: second.run.providerRunId! },
    })).toThrow("Provider Session and Run");
    expect(() => store.upsertApproval({ ...approvalInput(first, "wrong-item"), itemId: "different_item" }))
      .toThrow("item ownership");
    expect(() => store.upsertApproval({ ...input, display: { kind: "command", summary: "changed" } }))
      .toThrow("already bound to a different Approval");
  });

  it("claims an allowed decision exactly once across store connections", async () => {
    const { directory, store } = await createStore();
    const ownership = createActiveRun(store);
    const approval = store.upsertApproval(approvalInput(ownership));
    const peer = (await createStore(directory)).store;

    const claimed = store.claimApprovalDecision(approval.id, "accept");

    expect(claimed.approval.status).toBe("Accepted");
    expect(claimed.approval.decidedAt).toBeDefined();
    expect(claimed.binding).toEqual(approvalInput(ownership).binding);
    expect(() => peer.claimApprovalDecision(approval.id, "decline")).toThrow("no longer pending");
  });

  it("rejects decisions outside the Provider-normalized allowlist", async () => {
    const { store } = await createStore();
    const ownership = createActiveRun(store);
    const approval = store.upsertApproval(approvalInput(ownership));

    let rejected: unknown;
    try { store.claimApprovalDecision(approval.id, "acceptForSession"); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ statusCode: 400, code: "INVALID_REQUEST" });
    expect(() => store.resolveApproval(approval.id, "provider said C:\\private"))
      .toThrow("resolution reason is invalid");
    expect(store.getApproval(approval.id).status).toBe("Pending");
  });

  it("resolves every unfinished Approval atomically when its Run reaches a terminal state", async () => {
    const { store } = await createStore();
    const ownership = createActiveRun(store);
    const pending = store.upsertApproval(approvalInput(ownership, "pending"));
    const decided = store.upsertApproval(approvalInput(ownership, "decided"));
    store.claimApprovalDecision(decided.id, "decline");

    store.updateRunStatus(ownership.run.id, "Completed");

    const approvals = store.listApprovals({ runId: ownership.run.id });
    expect(approvals).toHaveLength(2);
    expect(approvals.every((approval) => approval.status === "Resolved")).toBe(true);
    expect(approvals.every((approval) => approval.resolutionReason === "RUN_COMPLETED")).toBe(true);
    expect(approvals.every((approval) => approval.resolvedAt !== undefined)).toBe(true);
    expect(() => store.claimApprovalDecision(pending.id, "accept")).toThrow("no longer pending");
    expect(store.upsertApproval(approvalInput(ownership, "pending"))).toEqual(store.getApproval(pending.id));
    expect(() => store.upsertApproval(approvalInput(ownership, "late"))).toThrow("finished Run");
  });

  it("keeps explicit resolution idempotent and preserves the first reason", async () => {
    const { store } = await createStore();
    const ownership = createActiveRun(store);
    const approval = store.upsertApproval(approvalInput(ownership));

    const resolved = store.resolveApproval(approval.id, "PROVIDER_RESOLVED");
    const duplicate = store.resolveApproval(approval.id, "DUPLICATE_NOTIFICATION");

    expect(resolved.status).toBe("Resolved");
    expect(duplicate.resolutionReason).toBe("PROVIDER_RESOLVED");
  });
});
