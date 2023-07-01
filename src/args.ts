import type vscode from "vscode";

export abstract class CliArg {
  readonly vscodeName: string;
  readonly cliName: string;
  readonly minVersion?: string;

  constructor(vscodeName: string, cliName: string, minVersion?: string) {
    this.vscodeName = vscodeName;
    this.cliName = cliName;
    if (minVersion != null) {
      this.minVersion = minVersion;
    }
  }

  abstract build(
    config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument,
    formattingOptions?: vscode.FormattingOptions
  ): string[];
}

class SimpleArg extends CliArg {
  constructor(cliName: string, minVersion?: string) {
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
}

class NumberOrNullArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<number | null>(this.vscodeName);
    return value != null ? [this.cliName, value.toString()] : [];
  }
}

class StringArrayArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<string[]>(this.vscodeName);
    return value?.length ? [this.cliName, value.join(",")] : [];
  }
}

class StringArg extends CliArg {
  build(config: vscode.WorkspaceConfiguration): string[] {
    const value = config.get<string>(this.vscodeName);
    return value ? [this.cliName, value] : [];
  }
}

class LinterOutputFormatArg extends CliArg {
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

class ProfileArg extends CliArg {
  constructor() {
    super("languages", "--profile");
  }

  build(
    config: vscode.WorkspaceConfiguration,
    document: vscode.TextDocument
  ): string[] {
    const languages = config.get<Record<string, string>>(this.vscodeName);
    const profile = languages?.[document.languageId];
    return profile ? [this.cliName, profile] : [];
  }
}

class UseEditorIndentationArg extends CliArg {
  constructor() {
    super("useEditorIndentation", "--indent");
  }

  build(
    config: vscode.WorkspaceConfiguration,
    _document: vscode.TextDocument,
    formattingOptions: vscode.FormattingOptions
  ): string[] {
    return config.get<boolean>(this.vscodeName)
      ? [this.cliName, formattingOptions.tabSize.toString()]
      : [];
  }
}

export const configurationArg = new StringArg(
  "configuration",
  "--configuration",
  "1.13"
);

const commonArgs: CliArg[] = [
  configurationArg,
  new SimpleArg("--quiet"),
  new BoolArg("requirePragma", "--require-pragma"),
  new BoolArg("useGitignore", "--use-gitignore"),
  new ProfileArg(),
  new StringArrayArg("exclude", "--exclude", "1.25"),
  new StringArrayArg("extendExclude", "--extend-exclude", "1.25"),
];

export const lintingArgs = commonArgs.concat(
  new SimpleArg("--lint"),
  new LinterOutputFormatArg(),
  new StringArrayArg("ignore", "--ignore"),
  new StringArrayArg("include", "--include", "1.20")
);

export const formattingArgs = commonArgs.concat(
  new SimpleArg("--reformat"),
  new BoolArg("closeVoidTags", "--close-void-tags", "1.26"),
  new BoolArg(
    "formatAttributeTemplateTags",
    "--format-attribute-template-tags",
    "1.25"
  ),
  new BoolArg("formatCss", "--format-css", "1.9"),
  new BoolArg("formatJs", "--format-js", "1.9"),
  new BoolArg("ignoreCase", "--ignore-case", "1.23"),
  new BoolArg("noFunctionFormatting", "--no-function-formatting", "1.30.2"),
  new BoolArg("noLineAfterYaml", "--no-line-after-yaml", "1.29"),
  new BoolArg("noSetFormatting", "--no-set-formatting", "1.30.2"),
  new BoolArg("preserveBlankLines", "--preserve-blank-lines", "1.3"),
  new BoolArg("preserveLeadingSpace", "--preserve-leading-space", "1.2"),
  new NumberOrNullArg("indentCss", "--indent-css", "1.25"),
  new NumberOrNullArg("indentJs", "--indent-js", "1.25"),
  new BoolArg(
    "lineBreakAfterMultilineTag",
    "--line-break-after-multiline-tag",
    "1.27"
  ),
  new NumberOrNullArg("maxAttributeLength", "--max-attribute-length", "1.25"),
  new NumberOrNullArg("maxBlankLines", "--max-blank-lines", "1.31"),
  new NumberOrNullArg("maxLineLength", "--max-line-length", "1.25"),
  new StringArrayArg("blankLineAfterTag", "--blank-line-after-tag", "1.25"),
  new StringArrayArg("blankLineBeforeTag", "--blank-line-before-tag", "1.25"),
  new StringArrayArg("customBlocks", "--custom-blocks", "1.25"),
  new StringArrayArg("customHtml", "--custom-html", "1.25"),
  new StringArrayArg("ignoreBlocks", "--ignore-blocks", "1.24"),
  new UseEditorIndentationArg()
);
