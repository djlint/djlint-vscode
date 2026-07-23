import type { LintDiagnostic } from "../../types.js";

// Golden values captured from real djLint 1.42.2 (profile "django").

export const FORMAT_INPUT = "<div><p>hi</p></div>";
export const FORMAT_EXPECTED = "<div>\n    <p>hi</p>\n</div>\n";

export const LINT_INPUT = '<img src="x">';
export const LINT_EXPECTED: LintDiagnostic[] = [
  {
    code: "H013",
    line: 1,
    column: 0,
    message: "Img tag should have an alt attribute.",
  },
];
