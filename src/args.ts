import type * as vscode from "vscode";
import { deriveStdinFilename } from "./stdin-filename.js";

export abstract class CliArg {
  constructor(
    readonly vscodeName: string,
    readonly cliName: string,
    readonly minVersion: string,
  ) {}

  /** The djLint `Config` kwarg name for this flag, e.g. `--max-line-length`
  -> `max_line_length`. */
  get kwargName(): string {
    return this.cliName.replace(/^--/u, "").replaceAll("-", "_");
  }

  abstract build(
    config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument,
    formattingOptions?: vscode.FormattingOptions,
  ): string[];

  /** The djLint `Config(**kwargs)` equivalent of `build()`, or `undefined`
  when this flag has no library-API counterpart (CLI-only) or the value is
  absent/empty, mirroring `build()`'s emission conditions. */
  abstract buildKwarg(
    config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument,
    formattingOptions?: vscode.FormattingOptions,
  ): [string, unknown] | undefined;
}

/** Base for flags with no djLint `Config` kwarg equivalent (CLI-only), e.g.
`--reformat` is implied by calling `formatter()`, `--quiet`/structured output
are native to the library API, and `--stdin-filename` has no `Config` kwarg
at all (see `StdinFilenameArg`'s own doc comment). `buildKwarg()` always
returns `undefined` for these. */
abstract class CliOnlyArg extends CliArg {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  override buildKwarg(): undefined {}
}

class SimpleArg extends CliOnlyArg {
  constructor(cliName: string, minVersion: string) {
    super("", cliName, minVersion);
  }

  build(): string[] {
    return [this.cliName];
  }
}

class BoolArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<boolean>(this.vscodeName);
    return value ? [this.cliName] : [];
  }

  buildKwarg(
    config: vscode.WorkspaceConfiguration,
  ): [string, unknown] | undefined {
    const value = config.get<boolean>(this.vscodeName);
    return value ? [this.kwargName, true] : void 0;
  }
}

class NumberOrNullArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<number | null>(this.vscodeName);
    return value == null ? [] : [this.cliName, value.toString()];
  }

  buildKwarg(
    config: vscode.WorkspaceConfiguration,
  ): [string, unknown] | undefined {
    const value = config.get<number | null>(this.vscodeName);
    return value == null ? void 0 : [this.kwargName, value];
  }
}

class StringArrayArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<string[]>(this.vscodeName);
    return value?.length ? [this.cliName, value.join(",")] : [];
  }

  buildKwarg(
    config: vscode.WorkspaceConfiguration,
  ): [string, unknown] | undefined {
    const value = config.get<string[]>(this.vscodeName);
    return value?.length ? [this.kwargName, value.join(",")] : void 0;
  }
}

class StringArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<string>(this.vscodeName);
    return value ? [this.cliName, value] : [];
  }

  buildKwarg(
    config: vscode.WorkspaceConfiguration,
  ): [string, unknown] | undefined {
    const value = config.get<string>(this.vscodeName);
    return value ? [this.kwargName, value] : void 0;
  }
}

class LinterOutputFormatArg extends CliOnlyArg {
  constructor() {
    super("useNewLinterOutputParser", "--linter-output-format", "1.25");
  }

  build(config: vscode.WorkspaceConfiguration): string[] {
    return config.get<boolean>(this.vscodeName)
      ? [
          this.cliName,
          "<filename>{filename}</filename><line>{line}</line><code>{code}</code><message>{message}</message>",
        ]
      : [];
  }
}

class UseEditorIndentationArg extends CliArg {
  constructor() {
    super("useEditorIndentation", "--indent", "0.4.3");
  }

  build(
    config: vscode.WorkspaceConfiguration,
    _document: vscode.TextDocument,
    formattingOptions: vscode.FormattingOptions,
  ): string[] {
    return config.get<boolean>(this.vscodeName)
      ? [this.cliName, formattingOptions.tabSize.toString()]
      : [];
  }

  buildKwarg(
    config: vscode.WorkspaceConfiguration,
    _document: vscode.TextDocument,
    formattingOptions?: vscode.FormattingOptions,
  ): [string, unknown] | undefined {
    if (formattingOptions == null || !config.get<boolean>(this.vscodeName)) {
      return void 0;
    }
    return [this.kwargName, formattingOptions.tabSize];
  }
}

/** A `StringArg` for a host filesystem path (`djlint.configuration`/
`djlint.rules`) that the bundled Pyodide engine cannot use: it runs sandboxed,
with no access to the host filesystem, and djLint's `Config` raises an
uncaught `FileNotFoundError` for a path it can't find — so `buildKwarg()`
always returns `undefined` here, meaning `buildConfigKwargs()` (used only by
the Pyodide engine, see `engine/kwargs.ts`) never forwards it. `build()` (the
CLI flag, used by the subprocess engine, which reads the path itself) is
unchanged. */
class PathOnlyArg extends StringArg {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  override buildKwarg(): undefined {}
}

// ⚠️ MUST equal the djLint version that first ships `--stdin-filename`.
const STDIN_FILENAME_MIN_VERSION = "1.43.0";

/** Passes the document's derived filename (see `deriveStdinFilename()`) as
`--stdin-filename`, so the subprocess path's `per-file-ignores` matching
works for stdin input the same way the Pyodide engine's already does (it
passes the filename directly to `linter()`/`formatter()`). Has no
library-API equivalent to send via `buildKwarg()` — djLint's `Config` takes
no filename kwarg; only its `linter()`/`formatter()` functions take a
`filepath` argument directly, which is exactly what the Pyodide engine
already does. Not user-configurable (no `djlint.*` setting), so
`vscodeName` is `""`, matching `SimpleArg`'s convention for CLI-only flags. */
class StdinFilenameArg extends CliOnlyArg {
  constructor() {
    super("", "--stdin-filename", STDIN_FILENAME_MIN_VERSION);
  }

  build(
    _config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument,
  ): string[] {
    return [this.cliName, deriveStdinFilename(document)];
  }
}

export const configurationArg = new PathOnlyArg(
  "configuration",
  "--configuration",
  "1.13",
);

export const rulesArg = new PathOnlyArg("rules", "--rules", "1.41");

const commonArgs = [
  configurationArg,
  new SimpleArg("--quiet", "0.0.9"),
  new BoolArg("requirePragma", "--require-pragma", "0.5.8"),
  new BoolArg("useGitignore", "--use-gitignore", "0.5.9"),
  new StringArg("profile", "--profile", "0.4.5"),
  new StringArrayArg("exclude", "--exclude", "1.25"),
  new StringArrayArg("extendExclude", "--extend-exclude", "1.25"),
] as const;

export const lintingArgs = [
  ...commonArgs,
  new LinterOutputFormatArg(),
  rulesArg,
  new StdinFilenameArg(),
  new StringArrayArg("ignore", "--ignore", "0.1.5"),
  new StringArrayArg("include", "--include", "1.20"),
] as const;

export const formattingArgs = [
  ...commonArgs,
  new SimpleArg("--reformat", "0.0.9"),
  new BoolArg("closeVoidTags", "--close-void-tags", "1.26"),
  new BoolArg("formatAttributeJsJson", "--format-attribute-js-json", "1.37"),
  new NumberOrNullArg(
    "formatAttributeJsJsonMinProps",
    "--format-attribute-js-json-min-props",
    "1.37",
  ),
  new StringArg(
    "formatAttributeJsJsonPattern",
    "--format-attribute-js-json-pattern",
    "1.37",
  ),
  new BoolArg(
    "formatAttributeTemplateTags",
    "--format-attribute-template-tags",
    "1.25",
  ),
  new BoolArg("formatCss", "--format-css", "1.9"),
  new BoolArg("formatJs", "--format-js", "1.9"),
  new BoolArg("ignoreCase", "--ignore-case", "1.23"),
  new BoolArg("noFunctionFormatting", "--no-function-formatting", "1.30.2"),
  new BoolArg("noLineAfterYaml", "--no-line-after-yaml", "1.29"),
  new BoolArg("noSetFormatting", "--no-set-formatting", "1.30.2"),
  new BoolArg("preserveBlankLines", "--preserve-blank-lines", "1.3"),
  new BoolArg("preserveClassNewlines", "--preserve-class-newlines", "1.39"),
  new BoolArg("preserveLeadingSpace", "--preserve-leading-space", "1.2"),
  new BoolArg("singleAttributePerLine", "--single-attribute-per-line", "1.40"),
  new NumberOrNullArg("indentCss", "--indent-css", "1.25"),
  new NumberOrNullArg("indentJs", "--indent-js", "1.25"),
  new BoolArg(
    "lineBreakAfterMultilineTag",
    "--line-break-after-multiline-tag",
    "1.27",
  ),
  new NumberOrNullArg("maxAttributeLength", "--max-attribute-length", "1.25"),
  new NumberOrNullArg("maxBlankLines", "--max-blank-lines", "1.31"),
  new NumberOrNullArg("maxLineLength", "--max-line-length", "1.25"),
  new StringArrayArg("blankLineAfterTag", "--blank-line-after-tag", "1.25"),
  new StringArrayArg("blankLineBeforeTag", "--blank-line-before-tag", "1.25"),
  new StringArrayArg("customBlocks", "--custom-blocks", "1.25"),
  new StringArrayArg("customHtml", "--custom-html", "1.25"),
  new StringArrayArg("ignoreBlocks", "--ignore-blocks", "1.24"),
  new UseEditorIndentationArg(),
] as const;
