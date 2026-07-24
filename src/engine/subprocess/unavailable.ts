import type { CustomExecaError } from "../../runner.js";

/** Fast, definite-unavailable shortcut: true when a failed djLint subprocess
invocation unambiguously means djLint is not available, as opposed to a
real linting/runtime error -- either the executable wasn't found (`ENOENT`)
or Python reports no `djlint` module (quotes optional in the pattern, since
CPython quotes the module name but the message is plain English on every
OS).

`code === "ENOENT"` is Unix-only: on Windows execa reports a missing
executable as an ordinary non-zero exit with a localized shell message (or
even a plain `TypeError`), which this check misses. `runner.ts`'s
`classifyRunFailure()` re-probe is the cross-platform backstop for whatever
this shortcut doesn't catch. */
export function isDjlintUnavailable(e: CustomExecaError): boolean {
  return (
    e.code === "ENOENT" ||
    /No\s+module\s+named\s+['"]?djlint['"]?(?![\w.])/u.test(e.stderr)
  );
}
