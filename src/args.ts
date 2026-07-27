import type * as vscode from "vscode";
import { LINTER_OUTPUT_FORMAT } from "./engine/subprocess/parse-lint-output.js";
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

  /** The user-facing label for this flag: `djlint.<vscodeName>` when it maps
  to a setting, else the bare CLI flag. Single source of truth for the
  "unsupported option" / "skipping option" messages. */
  get displayName(): string {
    return this.vscodeName ? `djlint.${this.vscodeName}` : this.cliName;
  }

  abstract build(
    config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument,
    formattingOptions?: vscode.FormattingOptions,
  ): string[];

  /** The djLint `Config(**kwargs)` equivalent of `build()`, or `undefined`
  when CLI-only or the value is absent/empty. */
  abstract buildKwarg(
    config: vscode.WorkspaceConfiguration,
    formattingOptions?: vscode.FormattingOptions,
  ): [string, unknown] | undefined;
}

/** Base for flags with no djLint `Config` kwarg equivalent, e.g.
`--reformat` (implied by calling `formatter()`) or `--stdin-filename` (no
`Config` kwarg at all). `buildKwarg()` always returns `undefined`. */
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

/** Pins djLint's linter output to {@link LINTER_OUTPUT_FORMAT} whenever
supported (>= 1.25), so `parseLinterOutput()` can rely on an edge-case-proof
format instead of djLint's ambiguous legacy default. Not user-configurable.
Unrelated to the Pyodide engine, which calls `linter()` directly. */
class LinterOutputFormatArg extends CliOnlyArg {
  constructor() {
    super("", "--linter-output-format", "1.25");
  }

  build(): string[] {
    return [this.cliName, LINTER_OUTPUT_FORMAT];
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
    formattingOptions?: vscode.FormattingOptions,
  ): [string, unknown] | undefined {
    if (formattingOptions == null || !config.get<boolean>(this.vscodeName)) {
      return void 0;
    }
    return [this.kwargName, formattingOptions.tabSize];
  }
}

/** A `StringArg` for a host filesystem path (`djlint.configuration`/
`djlint.rules`) that the sandboxed Pyodide engine can't use (no host
filesystem access) — `buildKwarg()` always returns `undefined`; `build()`
(the CLI flag, used by the subprocess engine) is unchanged. */
class PathOnlyArg extends StringArg {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  override buildKwarg(): undefined {}
}

/** Passes the document's derived filename as `--stdin-filename`, so
`per-file-ignores` matching works for stdin input like it already does on
the Pyodide path. No `buildKwarg()` equivalent — djLint's `Config` takes no
filename kwarg. */
class StdinFilenameArg extends CliOnlyArg {
  constructor() {
    // 1.43.0 is the djLint version that first shipped `--stdin-filename`.
    super("", "--stdin-filename", "1.43.0");
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
