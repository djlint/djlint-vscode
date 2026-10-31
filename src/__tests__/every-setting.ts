import type { CliArg } from "../args.js";

/** Every setting of `args` switched on, as the arg's own kind reads it. */
export function everySetting(args: readonly CliArg[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg.vscodeName === "") {
      continue;
    }
    switch (arg.constructor.name) {
      case "BoolArg":
      case "UseEditorIndentationArg": {
        values[arg.vscodeName] = true;
        break;
      }
      case "NumberOrNullArg": {
        values[arg.vscodeName] = 1;
        break;
      }
      case "ProfileArg":
      case "StringArg": {
        values[arg.vscodeName] = "x";
        break;
      }
      case "StringArrayArg": {
        values[arg.vscodeName] = ["x"];
        break;
      }
      // configuration and rules name files, and have tests of their own.
      case "WorkspacePathArg": {
        break;
      }
      default: {
        throw new Error(`No value for a ${arg.constructor.name}`);
      }
    }
  }
  return {
    ...values,
    formatAttributeJsJsonPattern: "^x-(?:data|init)$",
    profile: "django",
    quoteStyle: "double",
  };
}
