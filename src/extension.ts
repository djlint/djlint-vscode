import { execFile } from "child_process";
import * as vscode from "vscode";

function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("djlint");
}

function getArgs(document: vscode.TextDocument): string[] {
  switch (document.languageId) {
    case "django-html":
      return ["--profile", "django", document.fileName];
    case "jinja":
    case "jinja-html":
      return ["--profile", "jinja", document.fileName];
    default:
      return [document.fileName];
  }
}

function getPythonPath(
  configuration: vscode.WorkspaceConfiguration
): string | undefined {
  if (configuration.get<boolean>("useVenv")) {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (pythonExtension) {
      let pythonPath;
      if (pythonExtension.isActive) {
        pythonPath =
          pythonExtension.exports.settings.getExecutionDetails().execCommand[0];
      } else {
        pythonExtension.activate().then((api) => {
          pythonPath = api.settings.getExecutionDetails().execCommand[0];
        });
      }
      return pythonPath;
    }
  }
  const pythonPath = configuration.get<string>("pythonPath");
  if (!pythonPath) {
    vscode.window.showErrorMessage("Invalid djlint.pythonPath setting.");
  }
  return pythonPath;
}

function updateDjlint(): void {
  const pythonPath = getPythonPath(getConfiguration());
  if (!pythonPath) {
    return;
  }
  execFile(
    pythonPath,
    [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "--progress-bar",
      "off",
      "--disable-pip-version-check",
      "--no-color",
      "djlint",
    ],
    (_error, stdout, stderr) => {
      if (!stdout.includes("Successfully installed")) {
        vscode.window.showErrorMessage(stderr);
        return;
      }
      vscode.window
        .showInformationMessage(
          "Successfully installed djLint.",
          "Show installation log"
        )
        .then((option) => {
          if (option === "Show installation log") {
            vscode.window.showInformationMessage(stdout);
          }
        });
    }
  );
}

function ensureDjlintInstalled(stderr: string): void {
  if (!stderr.includes("No module named")) {
    return;
  }
  vscode.window
    .showErrorMessage("djLint is not installed.", "Install")
    .then((option) => {
      if (option === "Install") {
        updateDjlint();
      }
    });
}

function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  supportedLanguages: string[]
): void {
  const configuration = getConfiguration();
  if (
    !configuration.get<boolean>("enableLinting") ||
    !supportedLanguages.includes(document.languageId)
  ) {
    return;
  }
  const pythonPath = getPythonPath(configuration);
  if (!pythonPath) {
    return;
  }
  const ignore = configuration.get<string[]>("ignore");
  execFile(
    pythonPath,
    ["-m", "djlint", "--lint"]
      .concat(
        ignore === undefined || ignore.length === 0
          ? []
          : ["--ignore", ignore.join(",")]
      )
      .concat(getArgs(document)),
    (_error, stdout, stderr) => {
      ensureDjlintInstalled(stderr);
      const diags: vscode.Diagnostic[] = [];
      Array.from(
        stdout.matchAll(/^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm)
      ).forEach((value) => {
        const line = parseInt(value[2]) - 1;
        const column = parseInt(value[3]);
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(line, column, line, column),
            `${value[4]} (${value[1]})`
          )
        );
      });
      collection.set(document.uri, diags);
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  const supportedLanguages = ["html", "django-html", "jinja", "jinja-html"];
  vscode.commands.registerCommand("djlint.reinstall", updateDjlint);

  // Linting
  const collection = vscode.languages.createDiagnosticCollection("djLint");
  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      collection,
      supportedLanguages
    );
  }
  [
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        refreshDiagnostics(editor.document, collection, supportedLanguages);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) =>
      refreshDiagnostics(doc, collection, supportedLanguages)
    ),
    vscode.workspace.onDidCloseTextDocument((doc) =>
      collection.delete(doc.uri)
    ),
  ].forEach((event) => {
    context.subscriptions.push(event);
  });

  // Formatting
  vscode.languages.registerDocumentFormattingEditProvider(supportedLanguages, {
    provideDocumentFormattingEdits(
      document: vscode.TextDocument
    ): vscode.TextEdit[] {
      document.save().then((saved) => {
        if (!saved) {
          return;
        }
        const configuration = getConfiguration();
        const pythonPath = getPythonPath(configuration);
        if (!pythonPath) {
          return;
        }
        const indent = configuration.get<number>("indent");
        execFile(
          pythonPath,
          ["-m", "djlint", "--reformat", "--quiet"]
            .concat(
              indent === undefined || indent === 4
                ? []
                : ["--indent", indent.toString()]
            )
            .concat(getArgs(document)),
          (_error, _stderr, stderr) => {
            ensureDjlintInstalled(stderr);
          }
        );
      });
      return [];
    },
  });
}
