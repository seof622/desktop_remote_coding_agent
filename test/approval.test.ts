import { join } from "node:path";
import { readFileSync } from "node:fs";
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
  it("reads the Codex fileSystem.entries fixture and displays access modes and network scope", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex/permission-approval-request.json", import.meta.url), "utf8"));
    const request: ProviderApprovalRequest = { type: "permission", binding, availableDecisions: [], details: { type: "permission", cwd: workspacePath, permissions: fixture.params.permissions } };
    expect(approvalDisplay(project, request)).toEqual({
      type: "permission", filesystemEntries: ["읽기: 프로젝트 루트"], networkEnabled: true,
    });
  });

  it("keeps legacy and structured permission paths private and labels unknown scopes", () => {
    const request: ProviderApprovalRequest = {
      type: "permission", binding, availableDecisions: [],
      details: { type: "permission", cwd: workspacePath, reason: "token=private-value", permissions: {
        fileSystem: {
          read: [join(workspacePath, "src")], write: [join(workspacePath, "..", "private")],
          entries: [
            { access: "read", path: { type: "path", path: join(workspacePath, "src") } },
            { access: "write", path: { type: "special", value: { kind: "project_roots", subpath: "generated" } } },
            { access: "deny", path: { type: "glob_pattern", pattern: "C:\\Users\\private\\**\\.env" } },
            { access: "__proto__", path: { type: "special", value: { kind: "unknown", path: "C:\\Users\\private" } } },
            null,
          ],
        }, network: { enabled: false },
      } },
    };
    const display = approvalDisplay(project, request);
    expect(display).toEqual({ type: "permission", networkEnabled: false, reason: "token=<redacted>", filesystemEntries: [
      "읽기: src", "쓰기: <outside-workspace>", "쓰기: 프로젝트 루트 / generated", "차단: 패턴: <path>",
      "알 수 없는 접근: 알 수 없는 특수 범위", "알 수 없는 접근: 알 수 없는 범위",
    ] });
    expect(JSON.stringify(display)).not.toContain(workspacePath);
    expect(JSON.stringify(display)).not.toMatch(/Users|private-value/);
  });

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

  it("masks POSIX absolute paths beyond home directories without hiding URLs or relative paths", () => {
    const request: ProviderApprovalRequest = {
      type: "command", binding, availableDecisions: ["cancel"],
      details: { type: "command", kind: "command", cwd: workspacePath,
        command: `printf fixture > '/tmp/private-marker' --config=/var/tmp/private-config /mnt/c/private /opt/private /srv/private /run/private https://example.test/api/v1 src/relative.txt "${workspacePath}"`,
        reason: "write(/tmp/private-reason)",
      },
    };
    const display = approvalDisplay(project, request);
    const serialized = JSON.stringify(display);
    expect(serialized).not.toContain("private");
    expect(display).toMatchObject({ reason: "write(<path>)" });
    expect(serialized).toContain("https://example.test/api/v1");
    expect(serialized).toContain("src/relative.txt");
    expect(serialized).toContain("<workspace>");
  });
});
