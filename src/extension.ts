import { spawn } from "child_process";
import * as vscode from "vscode";

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("djlint");
}

function getArgs(document: vscode.TextDocument): string[] {
  switch (document.languageId) {
    case "django-html":
      return ["--profile", "django"];
    case "handlebars":
    case "hbs":
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

function getPythonPath(config: vscode.WorkspaceConfiguration): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (config.get<boolean>("useVenv")) {
      const pythonExtension =
        vscode.extensions.getExtension("ms-python.python");
      if (pythonExtension) {
        resolve(
          pythonExtension.activate().then(
            (api) =>
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
              api.settings.getExecutionDetails().execCommand[0]
          )
        );
        return;
      }
    }
    const pythonPath = config.get<string>("pythonPath");
    if (pythonPath) {
      resolve(pythonPath);
    } else {
      void vscode.window.showErrorMessage("Invalid djlint.pythonPath setting.");
      reject(pythonPath);
    }
  });
}

function installDjlint(): void {
  void getPythonPath(getConfig()).then((pythonPath) => {
    new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(pythonPath, [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--progress-bar",
        "off",
        "--disable-pip-version-check",
        "--no-color",
        "djlint",
      ]);
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("close", () => {
        if (
          stdout.includes("Successfully installed") ||
          stdout.includes("Requirement already satisfied: djlint")
        ) {
          resolve(stdout);
        } else {
          reject(stderr);
        }
      });
    })
      .then((stdout) => {
        void vscode.window
          .showInformationMessage(
            "Successfully installed djLint.",
            "Show installation log"
          )
          .then((option) => {
            if (option === "Show installation log") {
              void vscode.window.showInformationMessage(stdout);
            }
          });
      })
      .catch((stderr) => {
        if (typeof stderr === "string") {
          void vscode.window.showErrorMessage(stderr);
        }
      });
  });
}

function runDjlint(
  document: vscode.TextDocument,
  pythonPath: string,
  args: string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri);
    const child = spawn(
      pythonPath,
      ["-m", "djlint", "-"].concat(args).concat(getArgs(document)),
      cwd ? { cwd: cwd.uri.fsPath } : undefined
    );
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
        void vscode.window
          .showErrorMessage("djLint is not installed.", "Install")
          .then((option) => {
            if (option === "Install") {
              installDjlint();
            }
          });
        reject();
      } else {
        resolve(stdout);
      }
    });
  });
}

function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
  supportedLanguages: string[]
): void {
  const config = getConfig();
  if (
    !config.get<boolean>("enableLinting") ||
    !supportedLanguages.includes(document.languageId)
  ) {
    return;
  }
  void getPythonPath(config).then((pythonPath) => {
    const ignore = config.get<string[]>("ignore");
    void runDjlint(
      document,
      pythonPath,
      ["--lint"].concat(
        ignore === undefined || ignore.length === 0
          ? []
          : ["--ignore", ignore.join(",")]
      )
    ).then((stdout) => {
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
    });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const supportedLanguages = [
    "html",
    "django-html",
    "handlebars",
    "hbs",
    "jinja-html",
    "jinja",
    "nj",
    "njk",
    "nunjucks",
    "twig",
  ];
  vscode.commands.registerCommand("djlint.reinstall", installDjlint);

  // Linting
  const collection = vscode.languages.createDiagnosticCollection("djLint");
  if (vscode.window.activeTextEditor) {
    refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      collection,
      supportedLanguages
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) =>
      refreshDiagnostics(doc, collection, supportedLanguages)
    ),
    vscode.workspace.onDidSaveTextDocument((doc) =>
      refreshDiagnostics(doc, collection, supportedLanguages)
    ),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  // Formatting
  vscode.languages.registerDocumentFormattingEditProvider(supportedLanguages, {
    provideDocumentFormattingEdits(
      document: vscode.TextDocument
    ): Promise<vscode.TextEdit[]> {
      const config = getConfig();
      return getPythonPath(config).then((pythonPath) => {
        const indent = config.get<number | null>("indent");
        return runDjlint(
          document,
          pythonPath,
          ["--reformat"].concat(
            indent === undefined || indent === null
              ? []
              : ["--indent", indent.toString()]
          )
        ).then((stdout) => {
          const lastLineId = document.lineCount - 1;
          const range = new vscode.Range(
            0,
            0,
            lastLineId,
            document.lineAt(lastLineId).text.length
          );
          return [vscode.TextEdit.replace(range, stdout)];
        });
      });
    },
  });
}
