import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { GatewayError } from "./errors.js";

export async function validateWorkspacePath(candidate: string, allowedRoots: string[]): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new GatewayError(400, "INVALID_WORKSPACE", "Workspace path does not exist or cannot be resolved.");
  }

  const allowed = await Promise.all(allowedRoots.map(async (root) => realpath(root).catch(() => undefined)));
  const isWithinRoot = allowed.some((root) => {
    if (!root) return false;
    const pathRelative = relative(root, resolved);
    return pathRelative === "" || (!pathRelative.startsWith("..") && !pathRelative.includes("..\\") && !pathRelative.includes("../"));
  });
  if (!isWithinRoot) {
    throw new GatewayError(403, "WORKSPACE_NOT_ALLOWED", "Workspace is outside the configured allowed roots.");
  }
  return resolved;
}
