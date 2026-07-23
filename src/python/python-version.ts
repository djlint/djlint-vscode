/** A parsed `major.minor[.patch]` Python version. */
export interface PythonVersion {
  major: number;
  minor: number;
  patch: number | null;
}

/** Parse a version string like `"3.13.1"` or `"3.13"` (as reported by the
Python Environments extension's `PythonEnvironment.version`) into its numeric
parts. Returns `null` if the string doesn't start with a `major.minor`
prefix.

Two separate regexes (rather than one regex with an optional capture group)
are used deliberately: with this project's `noUncheckedIndexedAccess: false`
setting, an optional capture group's match is still typed as a plain
`string`, so a runtime `undefined` check on it would be flagged as an
unreachable condition. Requiring every named group in a given pattern keeps
the types honest. */
export function parsePythonVersion(version: string): PythonVersion | null {
  const withPatch = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(
    version,
  );
  if (withPatch?.groups != null) {
    const { major, minor, patch } = withPatch.groups;
    return {
      major: Number(major),
      minor: Number(minor),
      patch: Number(patch),
    };
  }

  const withoutPatch = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(version);
  if (withoutPatch?.groups != null) {
    const { major, minor } = withoutPatch.groups;
    return { major: Number(major), minor: Number(minor), patch: null };
  }

  return null;
}
