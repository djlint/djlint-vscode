import * as vscode from "vscode";

/** Tracks the in-flight `vscode.CancellationTokenSource` per document (keyed
by `document.uri.toString()`), so a new format/lint request cancels whatever
is still running for that document. Shared by `Formatter` and `Linter`,
which each own a separate instance. */
export class CancellationRegistry {
  readonly #running = new Map<string, vscode.CancellationTokenSource>();

  /** Cancels any run already registered for `key`, then registers a fresh
  `CancellationTokenSource` as the current run for `key`. */
  start(key: string): vscode.CancellationTokenSource {
    this.#running.get(key)?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.#running.set(key, source);
    return source;
  }

  /** Disposes `source` and, if still the registered run for `key`, removes
  the entry. Call in a `finally` once the run started by `start()`
  completes. */
  finish(key: string, source: vscode.CancellationTokenSource): void {
    source.dispose();
    if (this.#running.get(key) === source) {
      this.#running.delete(key);
    }
  }

  /** True while a run is still registered for `key`; check after `finish()`
  to detect whether a newer run has already superseded it. */
  has(key: string): boolean {
    return this.#running.has(key);
  }

  /** Cancels and disposes the in-flight run for `key`, without starting a
  replacement, e.g. when the document closes mid-run. */
  cancelAndDelete(key: string): void {
    const source = this.#running.get(key);
    source?.cancel();
    source?.dispose();
    this.#running.delete(key);
  }

  /** Cancels and disposes every in-flight run. Call on owner disposal. */
  disposeAll(): void {
    for (const source of this.#running.values()) {
      source.cancel();
      source.dispose();
    }
    this.#running.clear();
  }
}
