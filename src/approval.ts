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
  const filesystem = permissions.fileSystem !== null && typeof permissions.fileSystem === "object"
    ? permissions.fileSystem as Record<string, unknown> : {};
  const filesystemEntries: string[] = [];
  const accessLabels: Record<string, string> = { read: "읽기", write: "쓰기", deny: "차단" };
  const addPath = (mode: string, path: string | undefined) => {
    if (path) filesystemEntries.push((Object.hasOwn(accessLabels, mode) ? accessLabels[mode] : "알 수 없는 접근") + ": " + path);
  };
  for (const mode of ["read", "write"] as const) {
    if (Array.isArray(filesystem[mode])) {
      for (const path of filesystem[mode]) if (typeof path === "string") addPath(mode, projectRelativePath(path, project.workspacePath));
    }
  }
  const specialLabels: Record<string, string> = { root: "전체 파일시스템", minimal: "최소 시스템 경로", project_roots: "프로젝트 루트", tmpdir: "임시 디렉터리", slash_tmp: "/tmp" };
  for (const value of Array.isArray(filesystem.entries) ? filesystem.entries : []) {
    if (!value || typeof value !== "object") { addPath("unknown", "알 수 없는 범위"); continue; }
    const entry = value as Record<string, unknown>;
    const path = entry.path && typeof entry.path === "object" ? entry.path as Record<string, unknown> : {};
    if (path.type === "path" && typeof path.path === "string") addPath(String(entry.access), projectRelativePath(path.path, project.workspacePath));
    else if (path.type === "special" && path.value && typeof path.value === "object") {
      const special = path.value as Record<string, unknown>;
      const label = Object.hasOwn(specialLabels, String(special.kind)) ? specialLabels[String(special.kind)] : "알 수 없는 특수 범위";
      const subpath = typeof special.subpath === "string" ? projectRelativePath(special.subpath, project.workspacePath) : undefined;
      addPath(String(entry.access), label + (subpath ? " / " + subpath : ""));
    } else if (path.type === "glob_pattern") addPath(String(entry.access), "패턴: " + (maskSensitiveText(typeof path.pattern === "string" ? path.pattern : undefined, project.workspacePath, 512) || "알 수 없는 패턴"));
    else addPath(String(entry.access), "알 수 없는 범위");
  }
  const network = permissions.network;
  const networkEnabled = network !== null && typeof network === "object"
    && (network as Record<string, unknown>).enabled === true;
  const reason = maskSensitiveText(request.details.reason, project.workspacePath, 500);
  return {
    type: "permission",
    filesystemEntries: [...new Set(filesystemEntries)],
    networkEnabled,
    ...(reason ? { reason } : {}),
  };
}
