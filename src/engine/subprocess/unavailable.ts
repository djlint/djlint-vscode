import type { CustomExecaError } from "../../runner.js";

/** True when a failed djLint subprocess invocation means djLint itself is
not available in the resolved environment, as opposed to a real
linting/runtime error: either the executable could not be found at all
(`ENOENT`) or Python reports no `djlint` module. CPython quotes the module
name (`No module named 'djlint'`); the quotes are optional in the pattern so
both that and an unquoted variant match. Shared by `errors.ts` (quiet
rethrow, no popup) and `subprocess/index.ts`'s `asUnavailable()` (wraps as
`DjlintUnavailableError` for `FallbackEngine`) so the two checks cannot
drift apart — a single spot to fix already burned us once: the unquoted
pattern never matched CPython's actual (quoted) message. */
export function isDjlintUnavailable(e: CustomExecaError): boolean {
  return (
    e.code === "ENOENT" ||
    /No\s+module\s+named\s+['"]?djlint['"]?/u.test(e.stderr)
  );
}
