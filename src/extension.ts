import { spawn } from "child_process";
import * as vscode from "vscode";

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

function getProfileArg(document: vscode.TextDocument): string[] {
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

async function getPythonExec(
  config: vscode.WorkspaceConfiguration,
  document: vscode.TextDocument
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
    const childArgs = pythonExec[1]
      .concat(["-m", "djlint", "-"])
      .concat(args)
      .concat(getProfileArg(document));
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri);
    const options = cwd ? { cwd: cwd.uri.fsPath } : undefined;
    const child = spawn(pythonExec[0], childArgs, options);
    child.stdin.write(document.getText());
    child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("close", () => {
      if (stderr.includes("No module named")) {
        void vscode.window.showErrorMessage(
          "djLint is not installed for the current Python interpreter."
        );
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  supportedLanguages: string[]
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
    pythonExec = await getPythonExec(config, document);
  } catch (error) {
    return;
  }
  const ignore = config.get<string[]>("ignore");
  const args = ["--lint"];
  if (ignore !== undefined && ignore.length !== 0) {
    args.push("--ignore", ignore.join(","));
  }
  let stdout;
  try {
    stdout = await runDjlint(document, pythonExec, args);
  } catch (error) {
    return;
  }
  const diags: vscode.Diagnostic[] = [];
  const matches = stdout.matchAll(/^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm);
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

  // Linting
  const collection = vscode.languages.createDiagnosticCollection("djLint");
  if (vscode.window.activeTextEditor) {
    void refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      collection,
      supportedLanguages
    );
  }
  const diagListener = (doc: vscode.TextDocument) =>
    void refreshDiagnostics(doc, collection, supportedLanguages);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(diagListener),
    vscode.workspace.onDidSaveTextDocument(diagListener),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  // Formatting
  vscode.languages.registerDocumentFormattingEditProvider(supportedLanguages, {
    async provideDocumentFormattingEdits(
      document: vscode.TextDocument
    ): Promise<vscode.TextEdit[]> {
      const config = getConfig();
      let pythonPath;
      try {
        pythonPath = await getPythonExec(config, document);
      } catch (error) {
        return [];
      }
      const indent = config.get<number | null>("indent");
      const args = ["--reformat"];
      if (indent !== undefined && indent !== null) {
        args.push("--indent", indent.toString());
      }
      let stdout;
      try {
        stdout = await runDjlint(document, pythonPath, args);
      } catch (error) {
        return [];
      }
      const lastLineId = document.lineCount - 1;
      const lastLineLength = document.lineAt(lastLineId).text.length;
      const range = new vscode.Range(0, 0, lastLineId, lastLineLength);
      return [vscode.TextEdit.replace(range, stdout)];
    },
  });
}
