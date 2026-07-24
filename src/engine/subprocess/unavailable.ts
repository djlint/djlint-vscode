import type { CustomExecaError } from "../../runner.js";

/** Fast, definite-unavailable shortcut: true when a failed djLint subprocess
invocation unambiguously means djLint itself is not available in the
resolved environment, as opposed to a real linting/runtime error -- either
the executable could not be found at all (`ENOENT`) or Python reports no
`djlint` module. CPython quotes the module name (`No module named
'djlint'`); the quotes are optional in the pattern so both that and an
unquoted variant match. Python's message is plain English on every OS, so
that half of the check has no locale concerns.

This is a shortcut, not the full story: `code === "ENOENT"` is a Unix-only
fast path. On Windows, execa does NOT report `ENOENT` for a missing
executable -- a bare missing command comes back as an ordinary non-zero exit
with a LOCALIZED shell "not recognized" message, and a missing absolute path
can even throw a plain `TypeError` -- so this check alone silently misses a
vanished djLint there. The runtime re-probe in `runner.ts`
(`classifyRunFailure()`, which re-runs the same `--version` probe used at
resolution time) is the cross-platform backstop for whatever this shortcut
doesn't catch; this function only short-circuits the fast/common ENOENT and
missing-module cases ahead of that re-probe.

A single spot to fix already burned us once: the unquoted pattern never
matched CPython's actual (quoted) message. */
export function isDjlintUnavailable(e: CustomExecaError): boolean {
  return (
    e.code === "ENOENT" ||
    /No\s+module\s+named\s+['"]?djlint['"]?(?![\w.])/u.test(e.stderr)
  );
}
