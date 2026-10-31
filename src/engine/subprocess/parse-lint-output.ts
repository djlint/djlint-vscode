import type { LintDiagnostic } from "../types.js";

const FIELD_SEPARATOR = "\u{1F}";
const RECORD_SEPARATOR = "\u{1E}";

export const LINTER_OUTPUT_FORMAT = "{code}".concat(
  FIELD_SEPARATOR,
  "{line}",
  FIELD_SEPARATOR,
  "{message}",
  RECORD_SEPARATOR,
);

export const LINTER_OUTPUT_FORMAT_WITH_END = "{code}".concat(
  FIELD_SEPARATOR,
  "{line}",
  FIELD_SEPARATOR,
  "{message}",
  FIELD_SEPARATOR,
  "{end}",
  RECORD_SEPARATOR,
);

const END_REGEX = /^(?<line>\d+):(?<column>\d+)$/u;

const LEGACY_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

// A rule module can report line 0, which the bundled djLint moves to line 1 too.
function isValidPosition(line: number, column: number): boolean {
  return (
    Number.isSafeInteger(line) &&
    line >= 0 &&
    Number.isSafeInteger(column) &&
    column >= 0
  );
}

function endOf(
  field: string | undefined,
  line: number,
  column: number,
): Pick<LintDiagnostic, "endColumn" | "endLine"> {
  const groups = END_REGEX.exec(field ?? "")?.groups;
  if (!groups) {
    return {};
  }
  const endLine = Math.max(Number(groups["line"]), 1);
  const endColumn = Number(groups["column"]);
  const isAfterStart =
    endLine > line || (endLine === line && endColumn >= column);
  return isAfterStart ? { endColumn, endLine } : {};
}

function parsePinnedFormat(stdout: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (!record.trim()) {
      continue;
    }
    const parts = record.replace(/^\s+/u, "").split(FIELD_SEPARATOR);
    if (parts.length < 3) {
      continue;
    }
    const [code, lineColumn] = parts;
    const hasEnd = parts.length > 3 && END_REGEX.test(parts.at(-1) ?? "");
    const message = parts.slice(2, hasEnd ? -1 : void 0).join(FIELD_SEPARATOR);
    const lineColumnParts = lineColumn.split(":");
    if (lineColumnParts.length !== 2) {
      continue;
    }
    const [lineText, columnText] = lineColumnParts;
    const line = Number(lineText);
    const column = Number(columnText);
    if (!lineText || !isValidPosition(line, column)) {
      continue;
    }
    const firstLine = Math.max(line, 1);
    const end = hasEnd ? endOf(parts.at(-1), firstLine, column) : {};
    diags.push({ code, column, line: firstLine, message, ...end });
  }
  return diags;
}

function parseLegacyFormat(stdout: string): LintDiagnostic[] {
  const diags: LintDiagnostic[] = [];
  for (const { groups } of stdout.matchAll(LEGACY_OUTPUT_REGEX)) {
    if (!groups) {
      continue;
    }
    const line = Number(groups["line"]);
    const column = Number(groups["column"]);
    if (!isValidPosition(line, column)) {
      continue;
    }
    diags.push({
      code: groups["code"],
      column,
      line: Math.max(line, 1),
      message: groups["message"],
    });
  }
  return diags;
}

export function parseLinterOutput(stdout: string): LintDiagnostic[] {
  return stdout.includes(RECORD_SEPARATOR)
    ? parsePinnedFormat(stdout)
    : parseLegacyFormat(stdout);
}
