import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalDisplay, Project, ProviderApprovalRequest } from "./types.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function maskSensitiveText(value: string | undefined, workspacePath: string, maxLength: number): string | undefined {
  const cleaned = cleanText(value, maxLength * 2);
  if (!cleaned) return undefined;
  const workspacePattern = new RegExp(escapeRegExp(resolve(workspacePath)), "gi");
  return cleaned
    .replace(workspacePattern, "<workspace>")
    .replace(/((?:authorization)\s*[=:]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/\b(Bearer)\s+(?:"[^"]*"|'[^']*'|\S+)/gi, "$1 <redacted>")
    .replace(/((?:--?(?:token|api[_-]?key|password|secret)|(?:token|api[_-]?key|password|secret))\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/((?:--?(?:token|api[_-]?key|password|secret))\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/[A-Za-z]:\\[^\s"'`;]+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"'`;]+/g, "<path>")
    .slice(0, maxLength);
}

function projectRelativePath(value: string | undefined, workspacePath: string): string | undefined {
  const cleaned = cleanText(value, 4096);
  if (!cleaned) return undefined;
  const root = resolve(workspacePath);
  const candidate = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const within = relative(root, candidate);
  if (within === "") return ".";
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return "<outside-workspace>";
  return within.split(sep).join("/").slice(0, 512);
}

export function approvalDisplay(project: Project, request: ProviderApprovalRequest): ApprovalDisplay {
  if (request.details.type === "command") {
    const command = maskSensitiveText(request.details.command, project.workspacePath, 2_000);
    const cwd = projectRelativePath(request.details.cwd, project.workspacePath);
    const reason = maskSensitiveText(request.details.reason, project.workspacePath, 500);
    return {
      type: "command",
      kind: request.details.kind,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  if (request.details.type === "fileChange") {
    const grantRoot = projectRelativePath(request.details.grantRoot, project.workspacePath);
    const reason = maskSensitiveText(request.details.reason, project.workspacePath, 500);
    return {
      type: "fileChange",
      ...(grantRoot ? { grantRoot } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  const permissions = request.details.permissions;
  const filesystem = Array.isArray(permissions.filesystem) ? permissions.filesystem : [];
  const filesystemEntries = filesystem
    .map((entry) => typeof entry === "string" ? projectRelativePath(entry, project.workspacePath) : undefined)
    .filter((entry): entry is string => Boolean(entry));
  const network = permissions.network;
  const networkEnabled = network !== null && typeof network === "object"
    && (network as Record<string, unknown>).enabled === true;
  const reason = maskSensitiveText(request.details.reason, project.workspacePath, 500);
  return {
    type: "permission",
    filesystemEntries,
    networkEnabled,
    ...(reason ? { reason } : {}),
  };
}
