import type * as vscode from "vscode";

export class PyodideRunner {
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(private readonly outputChannel: vscode.LogOutputChannel) {}

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();
    return this.initializationPromise;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/require-await
  async runDjlint(): Promise<string> {
    // For now, throw an error with helpful message
    // Full Pyodide implementation can be added later if needed
    throw new Error(
      "Pyodide fallback is not yet implemented. Please install Python or enable the isolated environment option."
    );
  }

  dispose(): void {
    this.isInitialized = false;
    this.initializationPromise = null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async doInitialize(): Promise<void> {
    this.outputChannel.info("Pyodide runner is not yet implemented");
    this.isInitialized = true;
  }
}