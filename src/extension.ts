import { spawn } from "child_process";
import * as vscode from "vscode";

const supportedLanguages = [
  "html",
  "django-html",
  "handlebars",
  "hbs",
  "mustache",
  "jinja-html",
  "jinja",
  "nj",
  "njk",
  "nunjucks",
  "twig",
];

const formatBoolOptions = [
  ["requirePragma", "--require-pragma"],
  ["preserveLeadingSpace", "--preserve-leading-space"],
  ["preserveBlankLines", "--preserve-blank-lines"],
  ["formatCss", "--format-css"],
  ["formatJs", "--format-js"],
];

const versionedOptions = [
  ["configuration", "configuration", "1.13.0"],
  ["format-css", "formatCss", "1.9.0"],
  ["format-js", "formatJs", "1.9.0"],
  ["preserve-blank-lines", "preserveBlankLines", "1.3.0"],
  ["preserve-leading-space", "preserveLeadingSpace", "1.2.0"],
];

const lintRegex = /^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm;
const errorRegex = /Error.*/;

interface IExtensionApi {
  settings: {
    getExecutionDetails(resource?: vscode.Uri | undefined): {
      execCommand: string[] | undefined;
    };
  };
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("djlint");
}

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

function getCommonArgs(
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

function getLintArgs(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): string[] {
  const args = ["--lint"].concat(getCommonArgs(document, config));

  const ignore = config.get<string[]>("ignore");
  if (ignore !== undefined && ignore.length !== 0) {
    args.push("--ignore", ignore.join(","));
  }

  return args;
}

function getFormatArgs(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  options: vscode.FormattingOptions
): string[] {
  const args = ["--reformat"].concat(getCommonArgs(document, config));

  if (config.get<boolean>("useEditorIndentation")) {
    args.push("--indent", options.tabSize.toString());
  }

  for (const [key, value] of formatBoolOptions) {
    if (config.get<boolean>(key)) {
      args.push(value);
    }
  }

  return args;
}

function getErrorMsg(stderr: string): string | undefined {
  if (stderr.includes("No module named")) {
    return "djLint is not installed for the current active Python interpreter.";
  }
  for (const [cliOption, vscodeOption, minVersion] of versionedOptions) {
    if (stderr.includes(`No such option: --${cliOption}`)) {
      return `Your version of djLint does not support the ${vscodeOption} option. Disable it in the settings or install djLint>=${minVersion}.`;
    }
  }
  return stderr.match(errorRegex)?.toString();
}

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): Promise<[string, string[]]> {
  if (config.get<boolean>("useVenv")) {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (pythonExtension) {
      const api = (
        pythonExtension.isActive
          ? pythonExtension.exports
          : await pythonExtension.activate()
      ) as IExtensionApi;
      const execCommand = api.settings.getExecutionDetails(
        document.uri
      ).execCommand;
      if (execCommand) {
        const executable = execCommand.shift();
        if (executable) {
          return [executable, execCommand];
        }
      }
      const errMsg = "Failed to get Python interpreter from Python extension.";
      void vscode.window.showErrorMessage(errMsg);
      throw new Error(errMsg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return [pythonPath, []];
  }

  const errMsg = "Invalid djlint.pythonPath setting.";
  void vscode.window.showErrorMessage(errMsg);
  throw new Error(errMsg);
}

function runDjlint(
  document: vscode.TextDocument,
  pythonExec: [string, string[]],
  args: string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const childArgs = pythonExec[1].concat(["-m", "djlint", "-"]).concat(args);
    const cwd = vscode.Uri.joinPath(document.uri, "..");
    const childOptions = { cwd: cwd.fsPath };
    const child = spawn(pythonExec[0], childArgs, childOptions);
    child.stdin.write(document.getText());
    child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("close", () => {
      const errMsg = getErrorMsg(stderr);
      if (errMsg) {
        void vscode.window.showErrorMessage(errMsg);
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  if (!supportedLanguages.includes(document.languageId)) {
    return;
  }

  const config = getConfig();
  if (!config.get<boolean>("enableLinting")) {
    return;
  }

  let pythonExec;
  try {
    pythonExec = await getPythonExec(document, config);
  } catch (error) {
    return;
  }

  const args = getLintArgs(document, config);
  let stdout;
  try {
    stdout = await runDjlint(document, pythonExec, args);
  } catch (error) {
    return;
  }

  const diags = [];
  const matches = stdout.matchAll(lintRegex);
  for (const match of matches) {
    const line = parseInt(match[2]) - 1;
    const column = parseInt(match[3]);
    const range = new vscode.Range(line, column, line, column);
    const message = `${match[4]} (${match[1]})`;
    const diag = new vscode.Diagnostic(range, message);
    diags.push(diag);
  }
  collection.set(document.uri, diags);
}

export function activate(context: vscode.ExtensionContext): void {
  // Linting
  const collection = vscode.languages.createDiagnosticCollection("djLint");
  if (vscode.window.activeTextEditor) {
    void refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      collection
    );
  }
  const diagListener = (doc: vscode.TextDocument) =>
    void refreshDiagnostics(doc, collection);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(diagListener),
    vscode.workspace.onDidSaveTextDocument(diagListener),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  // Formatting
  vscode.languages.registerDocumentFormattingEditProvider(supportedLanguages, {
    async provideDocumentFormattingEdits(
      document: vscode.TextDocument,
      options: vscode.FormattingOptions
    ): Promise<vscode.TextEdit[]> {
      const config = getConfig();

      let pythonPath;
      try {
        pythonPath = await getPythonExec(document, config);
      } catch (error) {
        return [];
      }

      const args = getFormatArgs(document, config, options);
      let stdout;
      try {
        stdout = await runDjlint(document, pythonPath, args);
      } catch (error) {
        return [];
      }
      if (!stdout || stdout.trim().length === 0) {
        return [];
      }

      const lastLineId = document.lineCount - 1;
      const lastLineLength = document.lineAt(lastLineId).text.length;
      const range = new vscode.Range(0, 0, lastLineId, lastLineLength);
      return [vscode.TextEdit.replace(range, stdout)];
    },
  });
}
