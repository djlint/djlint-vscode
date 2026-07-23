import type { LintDiagnostic } from "../../types.js";

export interface ParityCase {
  name: string;
  profile: string;
  input: string;
  expectedFormat: string;
  expectedLint: LintDiagnostic[];
}

// Golden format + lint output captured from the bundled djLint 1.42.2 across a
// representative template per profile. Running lint over django/jinja/html
// exercises all nine python_module rule modules, so a bundling gap surfaces
// here as an ImportError.
export const PARITY_CASES: ParityCase[] = [
  {
    name: "django",
    profile: "django",
    input: '<div><img src="x"></div>',
    expectedFormat: '<div>\n    <img src="x">\n</div>\n',
    expectedLint: [
      {
        code: "H013",
        line: 1,
        column: 5,
        message: "Img tag should have an alt attribute.",
      },
    ],
  },
  {
    name: "jinja",
    profile: "jinja",
    input: "{% if a %}<p>{{ b }}</p>{% endif %}",
    expectedFormat: "{% if a %}<p>{{ b }}</p>{% endif %}\n",
    expectedLint: [],
  },
  {
    name: "handlebars",
    profile: "handlebars",
    input: "{{#if a}}<span>{{b}}</span>{{/if}}",
    expectedFormat: "{{#if a }}<span>{{b}}</span>{{/if}}\n",
    expectedLint: [],
  },
  {
    name: "golang",
    profile: "golang",
    input: "{{ if .A }}<div>{{ .B }}</div>{{ end }}",
    expectedFormat: "{{ if .A }}\n    <div>{{ .B }}</div>\n{{ end }}\n",
    expectedLint: [],
  },
  {
    name: "html",
    profile: "html",
    input: "<div><P>Hi</P></div>",
    expectedFormat: "<div>\n    <p>Hi</p>\n</div>\n",
    expectedLint: [
      {
        code: "H009",
        line: 1,
        column: 6,
        message: "Tag names should be lowercase.",
      },
      {
        code: "H009",
        line: 1,
        column: 11,
        message: "Tag names should be lowercase.",
      },
    ],
  },
];
