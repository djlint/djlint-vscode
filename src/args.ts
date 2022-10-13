import * as vscode from "vscode";

function getProfileArg(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): string[] {
  if (!config.get<boolean>("guessProfile")) {
    return [];
  }
  switch (document.languageId) {
    case "django-html":
      return ["--profile", "django"];
    case "handlebars":
    case "hbs":
    case "mustache":
      return ["--profile", "handlebars"];
    case "jinja":
    case "jinja-html":
      return ["--profile", "jinja"];
    case "nj":
    case "njk":
    case "nunjucks":
    case "twig":
      return ["--profile", "nunjucks"];
    default:
      return [];
  }
}

export function getCommonArgs(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): string[] {
  const args = getProfileArg(document, config);

  const configuration = config.get<string>("configuration");
  if (configuration) {
    args.push("--configuration", configuration);
  }

  return args;
}
