import { ExecaError } from "execa";
import { vi } from "vitest";
import * as vscode from "vscode";
import type { EngineManager } from "../engine/select.js";
import type { CustomExecaError } from "../engine/subprocess/exec.js";
import type { DjlintEngine } from "../engine/types.js";
import type { DjlintStatus } from "../status.js";
import { control, RecordingChannel, Uri } from "./vscode-stub.js";

export type TestChannel = RecordingChannel & vscode.LogOutputChannel;

export function makeStatus(): DjlintStatus {
  return { update: vi.fn() } as unknown as DjlintStatus;
}

export function makeChannel(): TestChannel {
  return new RecordingChannel() as unknown as TestChannel;
}

export function makeConfig(
  values: Readonly<Record<string, unknown>> = {},
): vscode.WorkspaceConfiguration {
  return {
    get: (key: string) => values[key],
  } as unknown as vscode.WorkspaceConfiguration;
}

export function makeDocument(
  location: string | vscode.Uri,
  text = "",
): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    lineCount: lines.length,
    uri: typeof location === "string" ? vscode.Uri.file(location) : location,
  } as unknown as vscode.TextDocument;
}

export function setWorkspaceFolders(...folders: readonly string[]): void {
  control.workspaceFolders = folders.map((folder) => ({
    uri: Uri.file(folder),
  }));
}

export const formattingOptions: vscode.FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
};

export function liveToken(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}

export function makeContext(extensionPath = "/x"): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(extensionPath),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/** An EngineManager whose engine is the given double. */
export function makeEngines(engine: Partial<DjlintEngine>): EngineManager {
  return { engine } as unknown as EngineManager;
}

/** Lets every promise chain that does not wait on real I/O run to its end. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Forward slashes and no drive letter, for paths `path.resolve()` anchored. */
export function portable(value: string): string {
  return value.replaceAll("\\", "/").replace(/^[a-z]:/iu, "");
}

/**
 * A ConfigurationChangeEvent for one changed setting, answering the way VS
 * Code does: true for the setting itself AND for any parent section of it, so
 * a query for `djlint` matches a change to `djlint.executablePath`.
 */
export function changeOf(
  changed: string,
  affects: (scope: unknown) => boolean = () => true,
): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: (query: string, scope?: unknown) =>
      (changed === query || changed.startsWith(`${query}.`)) &&
      (scope == null || affects(scope)),
  } as unknown as vscode.ConfigurationChangeEvent;
}

interface ExecaErrorFields {
  code?: string;
  exitCode?: number | undefined;
  isCanceled?: boolean;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
}

export function makeExecaError(fields: ExecaErrorFields): CustomExecaError {
  const shortMessage = fields.shortMessage ?? "Command failed";
  return Object.assign(new ExecaError(), {
    isCanceled: false,
    message: shortMessage,
    shortMessage,
    stderr: "",
    stdout: "",
    ...fields,
  }) as unknown as CustomExecaError;
}
