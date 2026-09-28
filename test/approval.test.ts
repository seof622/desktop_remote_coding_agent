import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalDisplay } from "../src/approval.js";
import type { Project, ProviderApprovalRequest } from "../src/types.js";

const workspacePath = join(process.cwd(), "workspace");
const project: Project = {
  id: "prj_test",
  name: "workspace",
  workspacePath,
  createdAt: "2026-09-28T00:00:00.000Z",
};

const binding = {
  providerRequestId: "request_private",
  providerConnectionId: "connection_private",
  connectionGeneration: 1,
  providerSessionId: "thread_private",
  providerRunId: "turn_private",
  providerItemId: "item_private",
};

describe("approvalDisplay", () => {
  it("masks secrets and absolute paths while keeping useful command context", () => {
    const request: ProviderApprovalRequest = {
      type: "command",
      binding,
      availableDecisions: ["accept", "decline"],
      details: {
        type: "command",
        kind: "command",
        command: `npm --token supersecret --prefix "${workspacePath}" --registry https://user:pass@example.test run test`,
        cwd: join(workspacePath, "packages", "gateway"),
        reason: "Authorization: Bearer topsecret\nrequested from C:\\Users\\private\\notes.txt",
      },
    };

    const display = approvalDisplay(project, request);
    const serialized = JSON.stringify(display);

    expect(display).toMatchObject({ type: "command", kind: "command", cwd: "packages/gateway" });
    expect(serialized).toContain("<workspace>");
    expect(serialized).toContain("<redacted>");
    expect(serialized).toContain("<path>");
    expect(serialized).not.toMatch(/supersecret|topsecret|user:pass|C:\\\\Users/i);
    expect(serialized).not.toContain(workspacePath);
  });

  it("marks file grants outside the registered Workspace without exposing the path", () => {
    const request: ProviderApprovalRequest = {
      type: "fileChange",
      binding: { ...binding, providerRequestId: "request_file", providerItemId: "item_file" },
      availableDecisions: ["accept", "decline", "cancel"],
      details: {
        type: "fileChange",
        grantRoot: join(workspacePath, "..", "private"),
        reason: "change files\u0000 safely",
      },
    };

    expect(approvalDisplay(project, request)).toEqual({
      type: "fileChange",
      grantRoot: "<outside-workspace>",
      reason: "change files safely",
    });
  });
});
