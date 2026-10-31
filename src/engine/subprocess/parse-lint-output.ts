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

const LEGACY_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

function isValidPosition(line: number, column: number): boolean {
  return (
    Number.isSafeInteger(line) &&
    line >= 1 &&
    Number.isSafeInteger(column) &&
    column >= 0
  );
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
    const message = parts.slice(2).join(FIELD_SEPARATOR);
    const lineColumnParts = lineColumn.split(":");
    if (lineColumnParts.length !== 2) {
      continue;
    }
    const [lineText, columnText] = lineColumnParts;
    const line = Number(lineText);
    const column = Number(columnText);
    if (!isValidPosition(line, column)) {
      continue;
    }
    diags.push({ code, column, line, message });
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
      line,
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
