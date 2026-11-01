import * as vscode from "vscode";
import { startExtension } from "./activate.js";
import { createBrowserWorker } from "./engine/pyodide/browser-worker.js";
import { PyodideEngine } from "./engine/pyodide/index.js";
import { EngineManager } from "./engine/select.js";
import { DjlintStatus } from "./status.js";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("djLint", { log: true });
  const status = new DjlintStatus();
  const { extensionUri } = context;
  const engines = new EngineManager(
    () =>
      new PyodideEngine(
        () =>
          createBrowserWorker(
            vscode.Uri.joinPath(extensionUri, "dist", "web", "pyodide-worker.js").toString(true),
            vscode.Uri.joinPath(extensionUri, "assets", "pyodide/").toString(true),
          ),
        outputChannel,
        vscode.workspace.isTrusted,
        status,
        () => void 0,
      ),
  );
  startExtension(context, outputChannel, status, engines);
}
