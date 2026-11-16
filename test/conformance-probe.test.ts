import { describe, expect, it } from "vitest";
import { filesystemProbeResult } from "../scripts/conformance-probe.js";

const executed = "Wall time: 0.1\nOutput:\nfixture-probe-started\nfixture-write-denied\nfixture-probe-finished\n";
describe("filesystem conformance evidence", () => {
  it("does not mistake an extra command approval rejection for enforced filesystem denial", () => {
    expect(filesystemProbeResult("exec_command failed: rejected by user", 1, false, false)).toBe("command-approval-required");
  });
  it("requires execution evidence even when the marker correctly appears absent", () => {
    expect(filesystemProbeResult("CreateProcess failed", 0, false, false)).toBe("command-not-executed");
    expect(filesystemProbeResult("Write-Output 'fixture-probe-started'; Write-Output 'fixture-probe-finished'", 0, false, false)).toBe("command-not-executed");
    expect(filesystemProbeResult("fixture-probe-started\n", 0, false, false)).toBe("command-not-executed");
  });
  it("reports unsupported Windows write boundaries without claiming permission denial", () => {
    expect(filesystemProbeResult("UnsupportedOperation: windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed", 0, false, true)).toBe("sandbox-layout-unsupported");
  });
  it("does not count an unavailable MXC sandbox as enforced denial", () => {
    expect(filesystemProbeResult("UnsupportedOperation: failed to prepare MXC sandbox: native MXC is unavailable on this executor", 0, false, false)).toBe("sandbox-unavailable");
  });
  it("verifies both denied writes and granted writes only after a complete probe", () => {
    expect(filesystemProbeResult(executed, 0, false, false)).toBe("verified");
    expect(filesystemProbeResult(executed.replaceAll("\n", "\r\n"), 0, true, true)).toBe("verified");
  });
  it("fails when the observed write disagrees with the requested scope", () => {
    expect(filesystemProbeResult(executed, 0, true, false)).toBe("write-result-mismatch");
    expect(filesystemProbeResult(executed, 0, false, true)).toBe("write-result-mismatch");
  });
  it("requires an observed write error before claiming denial", () => {
    expect(filesystemProbeResult(executed.replace("fixture-write-denied\n", ""), 0, false, false)).toBe("denial-not-observed");
    expect(filesystemProbeResult(executed.replace("fixture-write-denied", "command: Write-Output 'fixture-write-denied'"), 0, false, false)).toBe("denial-not-observed");
  });
});
