/** Shell quoting is required even for temporary fixture paths. */
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function fixtureWriteCommand(target: string, probe = false, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    const path = `'${target.replaceAll("'", "''")}'`;
    return {
      cmd: probe
        ? `Write-Output 'fixture-probe-started'; try { [System.IO.File]::WriteAllText(${path}, 'fixture') } catch { Write-Output 'fixture-write-denied' }; Write-Output 'fixture-probe-finished'`
        : `Set-Content -LiteralPath ${path} -Value fixture`,
      shell: "powershell", login: false,
    };
  }
  const write = `printf '%s' fixture > ${quotePosix(target)}`;
  return {
    cmd: probe
      ? `printf '%s\n' fixture-probe-started; if ! ( ${write} ); then printf '%s\n' fixture-write-denied; fi; printf '%s\n' fixture-probe-finished`
      : write,
    shell: "/bin/bash", login: false,
  };
}
