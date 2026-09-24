import * as vscode from "vscode";

export class CancellationRegistry {
  readonly #running = new Map<string, vscode.CancellationTokenSource>();

  start(key: string): vscode.CancellationTokenSource {
    this.#running.get(key)?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.#running.set(key, source);
    return source;
  }

  finish(key: string, source: vscode.CancellationTokenSource): void {
    source.dispose();
    const wasSuperseded = this.#running.get(key) !== source;
    if (!wasSuperseded) {
      this.#running.delete(key);
    }
  }

  has(key: string): boolean {
    return this.#running.has(key);
  }

  cancelAndDelete(key: string): void {
    const source = this.#running.get(key);
    source?.cancel();
    source?.dispose();
    this.#running.delete(key);
  }

  disposeAll(): void {
    for (const source of this.#running.values()) {
      source.cancel();
      source.dispose();
    }
    this.#running.clear();
  }
}
