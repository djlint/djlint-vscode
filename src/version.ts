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
