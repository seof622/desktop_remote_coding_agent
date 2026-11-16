export type FilesystemProbeResult = "verified" | "command-approval-required" | "sandbox-layout-unsupported" | "command-not-executed" | "write-result-mismatch";

/** A missing marker proves denial only when the sandboxed probe actually ran. */
export function filesystemProbeResult(output: unknown, commandApprovals: number, wrote: boolean, expectedWrite: boolean): FilesystemProbeResult {
  if (commandApprovals > 0) return "command-approval-required";
  const text = typeof output === "string" ? output : "";
  if (text.includes("cannot enforce split writable root sets")) return "sandbox-layout-unsupported";
  if (!/(?:^|\r?\n)fixture-probe-started(?:\r?\n|$)/.test(text)
    || !/(?:^|\r?\n)fixture-probe-finished(?:\r?\n|$)/.test(text)) return "command-not-executed";
  return wrote === expectedWrite ? "verified" : "write-result-mismatch";
}
