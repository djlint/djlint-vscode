import type * as vscode from "vscode";
import type { CliArg } from "./args.js";

/** Parses the version djLint prints for `--version` (e.g. `"djlint, version
1.42.3"`, also produced by `<python> -m djlint --version`), returning the
captured `major.minor[.patch]` string, or `null` when the output doesn't
match. Pure (string in, string out) so it is unit-testable without spawning
any process. */
export function parseDjlintVersion(stdout: string): string | null {
  return (
    /version\s+(?<version>\d+\.\d+(?:\.\d+)?)/u.exec(stdout)?.groups?.[
      "version"
    ] ?? null
  );
}

/** Splits a dot-separated version string into its numeric components, e.g.
`"1.42.3"` -> `[1, 42, 3]`. Non-numeric/empty components become `NaN`, which
compares as neither greater than, less than, nor equal to any number — a
malformed component therefore always counts as "different" in
`isVersionAtLeast()` rather than silently matching. */
function versionComponents(version: string): number[] {
  return version.split(".").map(Number);
}

/** Dot-separated numeric version compare: is `version` at least
`minVersion`? Components are compared numerically position by position (so
`"1.5"` is correctly less than `"1.25"`, unlike a lexicographic string
compare); a version with fewer components than the other is padded with `0`s
(so `"1.42"` equals `"1.42.0"`). Pure and unit-tested thoroughly. */
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

/** `${version}::${arg.cliName}` pairs `selectSupportedArgs()` has already
warned about, so the same skipped option is not re-logged on every
`runDjlintCommand()` call for as long as `runner.ts`'s resolved command stays
cached (up to its `RESOLUTION_TTL_MS`, i.e. potentially every save/lint in
between). Cleared by `resetSkippedArgWarnings()` — called from `runner.ts`'s
`invalidateDjlintCommandCache()`, and therefore by the `djlint.restart`
command — so a freshly (re-)resolved version warns again rather than staying
silent forever off a stale resolution. */
const warnedSkippedArgs = new Set<string>();

/** Clears `selectSupportedArgs()`'s per-version skipped-arg warning dedupe
(`warnedSkippedArgs`), so a version resolved anew warns about its unsupported
args again instead of staying silent off the old resolution's dedupe state.
Called by `runner.ts`'s `invalidateDjlintCommandCache()` as part of its own
cache-invalidation sweep. */
export function resetSkippedArgWarnings(): void {
  warnedSkippedArgs.clear();
}

/** Filters `args` down to the ones `version` actually supports (i.e.
`isVersionAtLeast(version, arg.minVersion)`), logging one
`outputChannel.warn()` the first time a given `(version, arg)` pair is
skipped — see `warnedSkippedArgs` — naming the option and the required
`minVersion`. Pure aside from the logging side effect, so it is
unit-testable with a fake `outputChannel` and no real `CliArg`/execa
involved. This is what keeps a djLint older than, say,
`STDIN_FILENAME_MIN_VERSION` from ever being sent `--stdin-filename` (or any
other option newer than its own version) — `errors.ts`'s "No such option"
handling remains as a safety net for anything this filter misses (e.g. an
option removed in a newer djLint than the one djlint-vscode targets). */
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
      const optionName = arg.vscodeName
        ? `djlint.${arg.vscodeName}`
        : arg.cliName;
      outputChannel.warn(
        `Skipping ${optionName} (${arg.cliName}): requires djLint >= ${arg.minVersion}, resolved djLint is ${version}.`,
      );
    }
    return false;
  });
}
