import * as vscode from "vscode";
import type { PythonEnvironments } from "../python/environment.js";
import type { DjlintStatus } from "../status.js";
import { getDocumentFolder } from "./document-folder.js";
import { PyodideEngine } from "./pyodide/index.js";
import { createNodeWorker } from "./pyodide/node-worker.js";
import { FallbackEngine } from "./select.js";
import { SubprocessEngine } from "./subprocess/index.js";
import type { DjlintEngine } from "./types.js";

export function createDesktopEngine(
  extensionUri: vscode.Uri,
  outputChannel: vscode.LogOutputChannel,
  pythonEnvironments: PythonEnvironments,
  status: DjlintStatus,
): DjlintEngine {
  const { isTrusted } = vscode.workspace;
  function makePyodide(): DjlintEngine {
    return new PyodideEngine(
      () =>
        createNodeWorker(
          vscode.Uri.joinPath(extensionUri, "dist", "pyodide-worker.cjs")
            .fsPath,
          vscode.Uri.joinPath(extensionUri, "assets", "pyodide").fsPath,
        ),
      outputChannel,
      isTrusted,
      status,
      getDocumentFolder,
    );
  }
  return isTrusted
    ? new FallbackEngine(
        new SubprocessEngine(outputChannel, pythonEnvironments, status),
        makePyodide,
        outputChannel,
      )
    : makePyodide();
}
