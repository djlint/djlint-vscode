import type * as vscode from "vscode";
import type { ArgContext, CliArg } from "../../args.js";

export function parseDjlintVersion(stdout: string): string | null {
  // The last one: a version manager's wrapper can print its own first.
  const matches = stdout
    .matchAll(/version\s+(?<version>\d+\.\d+(?:\.\d+)?)/gu)
    .toArray();
  return matches.at(-1)?.groups?.["version"] ?? null;
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

export function selectSupportedArgs(
  args: readonly CliArg[],
  version: string | null,
  context: ArgContext,
  warned: Set<string>,
  outputChannel: vscode.LogOutputChannel,
): readonly CliArg[] {
  return args.filter((arg) => {
    const required = arg.requiredVersion(context);
    if (version == null || isVersionAtLeast(version, required)) {
      return true;
    }
    const warnKey = `${version}::${arg.cliName}::${required}`;
    if (!warned.has(warnKey) && arg.build(context).length > 0) {
      warned.add(warnKey);
      outputChannel.warn(
        `Skipping ${arg.displayName} (${arg.cliName}): requires djLint >= ${required}, resolved djLint is ${version}.`,
      );
    }
    return false;
  });
}
