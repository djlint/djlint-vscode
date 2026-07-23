import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";

// Shared setup for the real-Pyodide-in-Node integration tests: build the worker bundle + minimal vscode-shaped fakes.

export async function buildWorker(): Promise<string> {
  const workerPath = path.join(
    mkdtempSync(path.join(tmpdir(), "djlint-worker-")),
    "worker.cjs",
  );
  await esbuild.build({
    entryPoints: ["src/engine/pyodide/worker.ts"],
    bundle: true,
    outfile: workerPath,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  return workerPath;
}

export function fakeDocument(text: string): any {
  return { getText: () => text };
}

export function fakeConfig(profile: string): any {
  return { get: (key: string) => (key === "profile" ? profile : undefined) };
}

export const fakeFormattingOptions: any = { tabSize: 4, insertSpaces: true };

export const fakeToken: any = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};
