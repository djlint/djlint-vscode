import type * as vscode from "vscode";
import type { CliArg } from "./args.js";

export function parseDjlintVersion(stdout: string): string | null {
  return (
    /version\s+(?<version>\d+\.\d+(?:\.\d+)?)/u.exec(stdout)?.groups?.[
      "version"
    ] ?? null
  );
}

export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const actual = version.split(".").map(Number);
  const required = minVersion.split(".").map(Number);
  const length = Math.max(actual.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const actualComponent = actual[index] ?? 0;
    const requiredComponent = required[index] ?? 0;
    if (actualComponent !== requiredComponent) {
      return actualComponent > requiredComponent;
    }
  }
  return true;
}

const warnedSkippedArgs = new Set<string>();

export function resetSkippedArgWarnings(): void {
  warnedSkippedArgs.clear();
}

export function selectSupportedArgs(
  args: readonly CliArg[],
  version: string,
  outputChannel: vscode.LogOutputChannel,
): readonly CliArg[] {
  return args.filter((arg) => {
    if (isVersionAtLeast(version, arg.minVersion)) {
      return true;
    }
    const warnKey = `${version}::${arg.cliName}`;
    if (!warnedSkippedArgs.has(warnKey)) {
      warnedSkippedArgs.add(warnKey);
      outputChannel.warn(
        `Skipping ${arg.displayName} (${arg.cliName}): requires djLint >= ${arg.minVersion}, resolved djLint is ${version}.`,
      );
    }
    return false;
  });
}
