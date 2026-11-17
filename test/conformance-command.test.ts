import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureWriteCommand } from "../scripts/conformance-command.js";
import { filesystemProbeResult } from "../scripts/conformance-probe.js";

describe("platform fixture commands", () => {
  it("keeps PowerShell paths literal", () => {
    const command = fixtureWriteCommand("C:\\fixture's data\\marker.txt", true, "win32");
    expect(command.shell).toBe("powershell");
    expect(command.cmd).toContain("'C:\\fixture''s data\\marker.txt'");
  });

  it.skipIf(process.platform === "win32")("treats shell metacharacters as path text and requires observed write denial", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-command-test-"));
    try {
      const target = join(directory, "quote' space $(exit 71) `exit 72` ; marker.txt");
      const granted = fixtureWriteCommand(target, true, "linux");
      const output = execFileSync(granted.shell, ["-c", granted.cmd], { encoding: "utf8" });
      expect(readFileSync(target, "utf8")).toBe("fixture");
      expect(filesystemProbeResult(output, 0, true, true)).toBe("verified");
      const denied = fixtureWriteCommand(join(directory, "missing", "marker.txt"), true, "linux");
      const failure = execFileSync(denied.shell, ["-c", denied.cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(filesystemProbeResult(failure, 0, false, false)).toBe("verified");
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
