import type { LintDiagnostic } from "../types.js";

/** ASCII Unit Separator (0x1F) and Record Separator (0x1E): control
characters that never appear in real linter messages, used to delimit
{@link LINTER_OUTPUT_FORMAT}'s fields and records so a message may contain
any character at all (`:`, HTML-like text, embedded newlines) and still
parse unambiguously. */
const FIELD_SEPARATOR = "\u{1F}";
const RECORD_SEPARATOR = "\u{1E}";

/** The `--linter-output-format` template sent for djLint >= 1.25.
Deliberately excludes `{match}` (arbitrary source text, the main hazard) and
puts `{message}` last: djLint does raw, unescaped `str.format()`
substitution, but nothing after `{message}` needs escaping since records are
delimited by {@link RECORD_SEPARATOR} rather than by the trailing newline
`echo()` appends. Built via `String#concat()`, not a template literal,
so the literal `{code}`/`{line}`/`{message}` placeholders aren't mistaken
for JS interpolation. */
export const LINTER_OUTPUT_FORMAT = "{code}".concat(
  FIELD_SEPARATOR,
  "{line}",
  FIELD_SEPARATOR,
  "{message}",
  RECORD_SEPARATOR,
);

/** The djLint default `linter_output_format`
(`"{code} {line} {message} {match}"`), emitted by djLint too old to support
`--linter-output-format` (< 1.25). `{match}` is left untouched: it is
trailing, arbitrary source text that diagnostics do not need. */
const LEGACY_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

function parsePinnedFormat(stdout: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    // `echo()`'s trailing newline becomes leading whitespace on the next chunk. `.trim()` is only used to detect that case (an all-whitespace record, i.e. the trailing chunk after the final RECORD_SEPARATOR). The record itself is never `.trim()`ed, since that would also strip significant leading/trailing whitespace djLint emitted in `{message}`.
    if (!record.trim()) {
      continue;
    }
    // `{code}` never starts with whitespace, so only the leading whitespace `echo()` added ahead of it is stripped here. Anything after the first FIELD_SEPARATOR, trailing whitespace in `{message}` included, is left untouched.
    const parts = record.replace(/^\s+/u, "").split(FIELD_SEPARATOR);
    if (parts.length < 3) {
      continue;
    }
    const [code, lineColumn] = parts;
    // Rejoin past index 1 so a stray FIELD_SEPARATOR inside the message doesn't truncate it.
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

/** Parses djLint's stdout into diagnostics, auto-detecting the format:
`stdout` containing {@link RECORD_SEPARATOR} means the pinned
`--linter-output-format` was sent (djLint >= 1.25); otherwise it's djLint's
legacy default, which is all older djLint ever emits. Both branches return
`[]` for empty/no-error output. */
export function parseLinterOutput(stdout: string): LintDiagnostic[] {
  return stdout.includes(RECORD_SEPARATOR)
    ? parsePinnedFormat(stdout)
    : parseLegacyFormat(stdout);
}
