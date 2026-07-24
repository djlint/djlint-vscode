import type { LintDiagnostic } from "../types.js";

/** ASCII Unit Separator (0x1F) and Record Separator (0x1E): control
characters that never appear in real linter messages, used to delimit
{@link LINTER_OUTPUT_FORMAT}'s fields and records so a message may contain
any character -- including `:`, HTML-like text, or embedded newlines --
and still parse unambiguously. */
const FIELD_SEPARATOR = "\u{1F}";
const RECORD_SEPARATOR = "\u{1E}";

/** The `--linter-output-format` template `LinterOutputFormatArg` (see
`args.ts`) sends for djLint >= 1.25, the version that introduced the flag.
Deliberately excludes `{match}` (arbitrary source text, the main hazard) and
puts `{message}` last: djLint's `build_output()` does raw, unescaped
`str.format()` substitution per error and `echo()` appends a trailing
newline, but neither matters here because {@link RECORD_SEPARATOR} -- not
that newline -- is what delimits records, so nothing after `{message}`
needs escaping. `{line}` expands to djLint's own `"<line>:<column>"` pair,
same as in the legacy default format below. Built via `String#concat()`, not
a template literal, so the literal `{code}`/`{line}`/`{message}` placeholders
aren't mistaken for JS interpolation. */
export const LINTER_OUTPUT_FORMAT = "{code}".concat(
  FIELD_SEPARATOR,
  "{line}",
  FIELD_SEPARATOR,
  "{message}",
  RECORD_SEPARATOR,
);

/** The djLint default `linter_output_format` (`"{code} {line} {message} {match}"`),
emitted by djLint versions too old to support `--linter-output-format`
(< 1.25, see `LinterOutputFormatArg`'s `minVersion`). `{match}` is left
untouched by this pattern -- it's trailing, arbitrary source text that isn't
needed for diagnostics. */
const LEGACY_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

function parsePinnedFormat(stdout: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    // Each record ends with a newline appended by djLint's echo(); after splitting on RECORD_SEPARATOR that newline becomes leading whitespace on the next chunk (and the final chunk is empty or all whitespace), so trim() clears it and an empty result means "no error here".
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(FIELD_SEPARATOR);
    if (parts.length < 3) {
      continue;
    }
    const [code, lineColumn] = parts;
    // A stray FIELD_SEPARATOR inside the message (never expected from real linter text) must not truncate it, so rejoin everything past index 1.
    const message = parts.slice(2).join(FIELD_SEPARATOR);
    const lineColumnParts = lineColumn.split(":");
    if (lineColumnParts.length !== 2) {
      continue;
    }
    const [line, column] = lineColumnParts;
    diags.push({ code, column: Number(column), line: Number(line), message });
  }
  return diags;
}

function parseLegacyFormat(stdout: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const { groups } of stdout.matchAll(LEGACY_OUTPUT_REGEX)) {
    if (!groups) {
      continue;
    }
    diags.push({
      code: groups["code"],
      column: Number(groups["column"]),
      line: Number(groups["line"]),
      message: groups["message"],
    });
  }
  return diags;
}

/** Parses djLint's stdout into diagnostics, auto-detecting which format it's
in: `stdout` containing {@link RECORD_SEPARATOR} means the pinned
`--linter-output-format` was sent (djLint >= 1.25, see
`LINTER_OUTPUT_FORMAT`); otherwise it's djLint's legacy default format,
which is what older djLint (< 1.25) always emits, since it never received
`--linter-output-format` in the first place -- see
`LinterOutputFormatArg`'s `minVersion` and `selectSupportedArgs()`
in `version.ts`, which is what guarantees the two are never mismatched.
Both branches return `[]` for empty/no-error output. Pure (string in,
diagnostics out) so it is unit-testable without spawning any process. */
export function parseLinterOutput(stdout: string): LintDiagnostic[] {
  return stdout.includes(RECORD_SEPARATOR)
    ? parsePinnedFormat(stdout)
    : parseLegacyFormat(stdout);
}
