import type { LintDiagnostic } from "../types.js";

const NEW_OUTPUT_REGEX =
  /^<filename>(?<filename>.*)<\/filename><line>(?<line>\d+):(?<column>\d+)<\/line><code>(?<code>.+)<\/code><message>(?<message>.+)<\/message>$/gmu;
const OLD_OUTPUT_REGEX =
  /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;

export function parseLinterOutput(
  stdout: string,
  isNewParser: boolean,
): LintDiagnostic[] {
  const base = isNewParser ? NEW_OUTPUT_REGEX : OLD_OUTPUT_REGEX;
  const regex = new RegExp(base.source, base.flags);
  const diags: LintDiagnostic[] = [];
  for (const { groups } of stdout.matchAll(regex)) {
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
