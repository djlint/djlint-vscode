import type * as vscode from "vscode";
import type { CliArg } from "./args.js";

/** Parses the version djLint prints for `--version` (e.g. `"djlint, version
1.42.3"`), returning the captured `major.minor[.patch]` string, or `null`
when the output doesn't match. */
export function parseDjlintVersion(stdout: string): string | null {
  return (
    /version\s+(?<version>\d+\.\d+(?:\.\d+)?)/u.exec(stdout)?.groups?.[
      "version"
    ] ?? null
  );
}

/** Splits a dot-separated version string into its numeric components, e.g.
`"1.42.3"` -> `[1, 42, 3]`. Non-numeric/empty components become `NaN`,
which always counts as "different" in `isVersionAtLeast()` rather than
silently matching. */
function versionComponents(version: string): number[] {
  return version.split(".").map(Number);
}

/** Dot-separated numeric version compare: is `version` at least
`minVersion`? Compared position by position numerically (so `"1.5"` is
correctly less than `"1.25"`); a version with fewer components is padded
with `0`s (`"1.42"` equals `"1.42.0"`). */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const actual = versionComponents(version);
  const required = versionComponents(minVersion);
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

/** `${version}::${arg.cliName}` pairs already warned about, so the same
skipped option isn't re-logged on every call while `runner.ts`'s resolved
command stays cached. Cleared by `resetSkippedArgWarnings()` (via
`invalidateDjlintCommandCache()`) so a freshly re-resolved version warns
again. */
const warnedSkippedArgs = new Set<string>();

/** Clears the per-version skipped-arg warning dedupe (`warnedSkippedArgs`),
called by `runner.ts`'s `invalidateDjlintCommandCache()`. */
export function resetSkippedArgWarnings(): void {
  warnedSkippedArgs.clear();
}

/** Filters `args` down to the ones `version` actually supports, logging one
warning the first time a given `(version, arg)` pair is skipped. This keeps
an option newer than the resolved djLint from ever being sent; `errors.ts`'s
"No such option" handling is the safety net for anything this filter
misses. */
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
      const optionName = arg.displayName;
      outputChannel.warn(
        `Skipping ${optionName} (${arg.cliName}): requires djLint >= ${arg.minVersion}, resolved djLint is ${version}.`,
      );
    }
    return false;
  });
}
