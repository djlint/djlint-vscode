import type * as vscode from "vscode";

import {
  LINTER_OUTPUT_FORMAT,
  LINTER_OUTPUT_FORMAT_WITH_END,
} from "./engine/subprocess/parse-lint-output.js";
import { isVersionAtLeast } from "./engine/subprocess/version.js";
import { deriveStdinFilename, resolveWorkspaceFilePath } from "./paths.js";

export interface ArgContext {
  config: vscode.WorkspaceConfiguration;
  document: vscode.TextDocument;
  formattingOptions?: vscode.FormattingOptions;
  djlintVersion?: string | null;
}

const LINTER_END_MIN_VERSION = "1.48";
const ABSOLUTE_STDIN_FILENAME_MIN_VERSION = "1.49";

type ArgValue = boolean | number | string;

export abstract class CliArg {
  readonly isPath: boolean = false;
  readonly displayName: string;
  readonly #kwargName: string;

  constructor(
    readonly vscodeName: string,
    readonly cliName: string,
    readonly minVersion: string,
  ) {
    this.#kwargName = cliName.replace(/^--/u, "").replaceAll("-", "_");
    this.displayName = vscodeName ? `djlint.${vscodeName}` : cliName;
  }

  requiredVersion(_context: ArgContext): string {
    return this.minVersion;
  }

  build(context: ArgContext): string[] {
    const value = this.read(context);
    if (value == null) {
      return [];
    }
    return value === true ? [this.cliName] : [this.cliName, String(value)];
  }

  buildKwarg(context: ArgContext): [string, ArgValue] | undefined {
    const value = this.read(context);
    return value == null ? void 0 : [this.#kwargName, value];
  }

  protected abstract read(context: ArgContext): ArgValue | undefined;
}

abstract class CliOnlyArg extends CliArg {
  // oxlint-disable-next-line class-methods-use-this, no-empty-function
  override buildKwarg(): undefined {}
}

class SimpleArg extends CliOnlyArg {
  constructor(cliName: string, minVersion: string) {
    super("", cliName, minVersion);
  }

  // oxlint-disable-next-line class-methods-use-this
  protected read(): true {
    return true;
  }
}

class BoolArg extends CliArg {
  protected read({ config }: ArgContext): true | undefined {
    return config.get<boolean>(this.vscodeName) ? true : void 0;
  }
}

class NumberOrNullArg extends CliArg {
  protected read({ config }: ArgContext): number | undefined {
    return config.get<number | null>(this.vscodeName) ?? void 0;
  }
}

class StringArrayArg extends CliArg {
  protected read({ config }: ArgContext): string | undefined {
    const value = config.get<string[]>(this.vscodeName);
    return value?.length ? value.join(",") : void 0;
  }
}

class StringArg extends CliArg {
  protected read({ config }: ArgContext): string | undefined {
    const value = config.get<string>(this.vscodeName);
    return value === "" ? void 0 : value;
  }
}

const PROFILE_MIN_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["all", "1.44"],
  ["askama", "1.42"],
  ["liquid", "1.42"],
  ["tera", "1.42"],
]);

class ProfileArg extends StringArg {
  constructor() {
    super("profile", "--profile", "0.4.5");
  }

  override requiredVersion(context: ArgContext): string {
    return PROFILE_MIN_VERSIONS.get(this.read(context) ?? "") ?? this.minVersion;
  }
}

class LinterOutputFormatArg extends CliOnlyArg {
  constructor() {
    super("", "--linter-output-format", "1.25");
  }

  // oxlint-disable-next-line class-methods-use-this
  protected read({ djlintVersion }: ArgContext): string {
    return djlintVersion != null && isVersionAtLeast(djlintVersion, LINTER_END_MIN_VERSION)
      ? LINTER_OUTPUT_FORMAT_WITH_END
      : LINTER_OUTPUT_FORMAT;
  }
}

class StdinFilenameArg extends CliOnlyArg {
  constructor() {
    super("", "--stdin-filename", "1.43.0");
  }

  // A relative path counts from the folder djLint runs in, which is the document's, and not from the workspace.
  // oxlint-disable-next-line class-methods-use-this
  protected read({ djlintVersion, document }: ArgContext): string {
    return djlintVersion != null &&
      document.uri.scheme === "file" &&
      isVersionAtLeast(djlintVersion, ABSOLUTE_STDIN_FILENAME_MIN_VERSION)
      ? document.uri.fsPath
      : deriveStdinFilename(document);
  }
}

class WorkspacePathArg extends CliArg {
  override readonly isPath = true;

  protected read({ config, document }: ArgContext): string | undefined {
    const value = config.get<string>(this.vscodeName);
    return value ? resolveWorkspaceFilePath(value, document) : void 0;
  }
}

class UseEditorIndentationArg extends CliArg {
  constructor() {
    super("useEditorIndentation", "--indent", "0.4.3");
  }

  protected read({ config, formattingOptions }: ArgContext): number | undefined {
    return config.get<boolean>(this.vscodeName) ? formattingOptions?.tabSize : void 0;
  }
}

export const configurationArg = new WorkspacePathArg("configuration", "--configuration", "1.13");

export const rulesArg = new WorkspacePathArg("rules", "--rules", "1.41");

const commonArgs = [
  configurationArg,
  new SimpleArg("--quiet", "0.0.9"),
  new BoolArg("requirePragma", "--require-pragma", "0.5.8"),
  new BoolArg("useGitignore", "--use-gitignore", "0.5.9"),
  new ProfileArg(),
  new StringArg("quoteStyle", "--quote-style", "1.45"),
  new StringArrayArg("exclude", "--exclude", "1.25"),
  new StringArrayArg("extendExclude", "--extend-exclude", "1.25"),
  new StdinFilenameArg(),
  // These change what the linter reports, not only how the formatter writes.
  new BoolArg("closeVoidTags", "--close-void-tags", "1.26"),
  new BoolArg("ignoreCase", "--ignore-case", "1.23"),
  new BoolArg("preserveBlankLines", "--preserve-blank-lines", "1.3"),
  new NumberOrNullArg("maxBlankLines", "--max-blank-lines", "1.31"),
  new StringArrayArg("customBlocks", "--custom-blocks", "1.25"),
  new StringArrayArg("customHtml", "--custom-html", "1.25"),
  new StringArrayArg("ignoreBlocks", "--ignore-blocks", "1.24"),
] as const;

export const lintingArgs = [
  ...commonArgs,
  new LinterOutputFormatArg(),
  rulesArg,
  new StringArrayArg("ignore", "--ignore", "0.1.5"),
  new StringArrayArg("include", "--include", "1.20"),
] as const;

export const formattingArgs = [
  ...commonArgs,
  new SimpleArg("--reformat", "0.0.9"),
  new BoolArg("formatAttributeJsJson", "--format-attribute-js-json", "1.37"),
  new NumberOrNullArg(
    "formatAttributeJsJsonMinProps",
    "--format-attribute-js-json-min-props",
    "1.37",
  ),
  new StringArg("formatAttributeJsJsonPattern", "--format-attribute-js-json-pattern", "1.37"),
  new BoolArg("formatAttributeTemplateTags", "--format-attribute-template-tags", "1.25"),
  new BoolArg("formatCss", "--format-css", "1.9"),
  new BoolArg("formatJs", "--format-js", "1.9"),
  new BoolArg("keepBrInline", "--keep-br-inline", "1.45"),
  new BoolArg("nameEndblocks", "--name-endblocks", "1.45"),
  new BoolArg("noEntityFormatting", "--no-entity-formatting", "1.45"),
  new BoolArg("noFunctionFormatting", "--no-function-formatting", "1.30.2"),
  new BoolArg("noIndentInnerHtml", "--no-indent-inner-html", "1.45"),
  new BoolArg("noLineAfterYaml", "--no-line-after-yaml", "1.29"),
  new BoolArg("noSetFormatting", "--no-set-formatting", "1.30.2"),
  new BoolArg("preserveClassNewlines", "--preserve-class-newlines", "1.39"),
  new BoolArg("preserveLeadingSpace", "--preserve-leading-space", "1.2"),
  new BoolArg("singleAttributePerLine", "--single-attribute-per-line", "1.40"),
  new BoolArg("sortAttributes", "--sort-attributes", "1.45"),
  new BoolArg("sortLoadTags", "--sort-load-tags", "1.47"),
  new NumberOrNullArg("indentCss", "--indent-css", "1.25"),
  new NumberOrNullArg("indentJs", "--indent-js", "1.25"),
  new BoolArg("lineBreakAfterMultilineTag", "--line-break-after-multiline-tag", "1.27"),
  new NumberOrNullArg("maxAttributeLength", "--max-attribute-length", "1.25"),
  new NumberOrNullArg("maxLineLength", "--max-line-length", "1.25"),
  new StringArrayArg("blankLineAfterTag", "--blank-line-after-tag", "1.25"),
  new StringArrayArg("blankLineBeforeTag", "--blank-line-before-tag", "1.25"),
  new UseEditorIndentationArg(),
] as const;

export function buildOptions(
  context: ArgContext,
  mode: "format" | "lint",
): { options: Record<string, ArgValue>; pathOptions: Record<string, string> } {
  const options: Record<string, ArgValue> = {};
  const pathOptions: Record<string, string> = {};
  const args = mode === "format" ? formattingArgs : lintingArgs;
  for (const arg of args) {
    const kwarg = arg.buildKwarg(context);
    if (kwarg == null) {
      continue;
    }
    const [name, value] = kwarg;
    if (!arg.isPath) {
      options[name] = value;
    } else if (typeof value === "string") {
      pathOptions[name] = value;
    }
  }
  return { options, pathOptions };
}
