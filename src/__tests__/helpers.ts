import { assert, vi } from "vitest";
import * as vscode from "vscode";

import type { EngineManager } from "../engine/select.js";
import { run, RunError } from "../engine/subprocess/exec.js";
import type { RunFailure } from "../engine/subprocess/exec.js";
import { RUN_TIMEOUT_MS } from "../engine/types.js";
import type { DjlintEngine } from "../engine/types.js";
import type { PythonEnvironments } from "../python/environment.js";
import type { DjlintStatus } from "../status.js";
import { control, RecordingChannel, Uri } from "./vscode-stub.js";

export type TestChannel = RecordingChannel & vscode.LogOutputChannel;

export function makeStatus(): DjlintStatus {
  return { clear: vi.fn(), update: vi.fn() } as unknown as DjlintStatus;
}

export function makePythonEnvironments(
  getActive: PythonEnvironments["getActive"] = async () => null,
): { environments: PythonEnvironments; fireChange: () => void } {
  const listeners = new Set<() => void>();
  const environments = {
    getActive,
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  } as unknown as PythonEnvironments;
  return {
    environments,
    fireChange: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

export function makeChannel(): TestChannel {
  return new RecordingChannel() as unknown as TestChannel;
}

export function makeConfig(
  values: Readonly<Record<string, unknown>> = {},
): vscode.WorkspaceConfiguration {
  return { get: (key: string) => values[key] } as unknown as vscode.WorkspaceConfiguration;
}

export function makeDocument(location: string | vscode.Uri, text = ""): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    getText: () => text,
    offsetAt: ({ character, line }: vscode.Position) =>
      lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0) + character,
    languageId: "html",
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    lineCount: lines.length,
    uri: typeof location === "string" ? vscode.Uri.file(location) : location,
    version: 1,
  } as unknown as vscode.TextDocument;
}

export function setWorkspaceFolders(...folders: readonly string[]): void {
  control.workspaceFolders = folders.map((folder) => ({
    name: folder.split("/").at(-1) ?? "",
    uri: Uri.file(folder),
  }));
}

export const formattingOptions: vscode.FormattingOptions = { insertSpaces: true, tabSize: 2 };

export function liveToken(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}

export function makeContext(extensionPath = "/x"): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(extensionPath),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/**
 * An EngineManager whose engine is the given double.
 * @param engine - The methods of DjlintEngine the test calls.
 * @returns A stand-in for EngineManager with nothing but `engine`.
 */
export function makeEngines(engine: Partial<DjlintEngine>): EngineManager {
  return { engine } as unknown as EngineManager;
}

/** Lets every promise chain that does not wait on real I/O run to its end. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Forward slashes and no drive letter, for paths `path.resolve()` anchored.
 * @param value - A path, which on Windows has backslashes and a drive letter.
 * @returns The path as it reads on POSIX, so one expectation holds on every OS.
 */
export function portable(value: string): string {
  return value.replaceAll("\\", "/").replace(/^[a-z]:/iu, "");
}

/**
 * A ConfigurationChangeEvent for one changed setting, answering the way VS
 * Code does: true for the setting itself AND for any parent section of it, so
 * a query for `djlint` matches a change to `djlint.executablePath`.
 * @param changed - The full name of the setting that changed, such as `djlint.executablePath`.
 * @param affects - Whether the change applies to a scope a query names; every scope by default.
 * @returns The event, as `onDidChangeConfiguration` hands it to a listener.
 */
export function changeOf(
  changed: string,
  affects: (scope: unknown) => boolean = () => true,
): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: (query: string, scope?: unknown) =>
      (changed === query || changed.startsWith(`${query}.`)) && (scope == null || affects(scope)),
  } as unknown as vscode.ConfigurationChangeEvent;
}

export function makeRunError(failure: RunFailure): RunError {
  return new RunError("djlint -", failure);
}

/**
 * How a run that must fail failed.
 * @param running - The run.
 * @returns The RunError it rejected with.
 */
export async function failureOf(running: Promise<unknown>): Promise<RunError> {
  try {
    await running;
  } catch (e) {
    assert(e instanceof RunError);
    return e;
  }
  throw new Error("the command succeeded");
}

/**
 * The djLint on PATH, for the suites that run it.
 * @returns What its `--version` prints, or null where none runs.
 */
export async function installedDjlint(): Promise<string | null> {
  try {
    const { stdout } = await run("djlint", ["--version"], { timeout: RUN_TIMEOUT_MS });
    return stdout;
  } catch {
    return null;
  }
}
