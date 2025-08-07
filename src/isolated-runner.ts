/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-require-imports, unicorn/import-style */
import { execa } from "execa";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { CliArg } from "./args.js";

export class IsolatedDjlintRunner {
  private readonly venvPath: string;
  private readonly djlintPath: string;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    extensionPath: string,
  ) {
    this.venvPath = path.join(extensionPath, "djlint-venv");
    this.djlintPath = process.platform === "win32" 
      ? path.join(this.venvPath, "Scripts", "python.exe")
      : path.join(this.venvPath, "bin", "python");
  }

  private static findPythonExecutable(): string {
    // Try to find a suitable Python executable
    const candidates = process.platform === "win32" 
      ? ["python", "python3", "py"]
      : ["python3", "python"];

    for (const candidate of candidates) {
      try {
        // Test if this Python has venv module
        require("node:child_process").execSync(`${candidate} -m venv --help`, { 
          stdio: "ignore", 
          timeout: 5000,
        });
        return candidate;
      } catch {
        // Try next candidate
      }
    }

    throw new Error("No suitable Python executable found. Python 3.3+ is required.");
  }

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

  async runDjlint(
    content: string,
    args: readonly CliArg[],
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions?: vscode.FormattingOptions,
  ): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Build arguments similar to the original runner
      const cliArgs = [
        "-m",
        "djlint",
        "-",
        ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
      ];

      const result = await execa(this.djlintPath, cliArgs, {
        input: content,
        stripFinalNewline: false,
      });

      return result.stdout;
    } catch (e: unknown) {
      this.outputChannel.error(`Isolated djLint execution failed: ${String(e)}`);
      throw e;
    }
  }

  dispose(): void {
    // Note: We don't delete the venv here as it might be in use
    // The venv will be cleaned up when the extension is uninstalled
    this.isInitialized = false;
    this.initializationPromise = null;
  }

  private async doInitialize(): Promise<void> {
    try {
      // Check if venv already exists and is valid
      if (await this.isVenvValid()) {
        this.outputChannel.info("Using existing djLint virtual environment");
        this.isInitialized = true;
        return;
      }

      this.outputChannel.info("Setting up isolated djLint environment...");
      
      // Create virtual environment
      await this.createVenv();
      
      // Install djLint in the virtual environment
      await this.installDjlint();

      this.outputChannel.info("djLint isolated environment setup completed");
      this.isInitialized = true;
    } catch (e: unknown) {
      this.outputChannel.error(`Failed to initialize isolated djLint environment: ${String(e)}`);
      throw e;
    }
  }

  private async isVenvValid(): Promise<boolean> {
    try {
      // Check if djlint path exists
      if (!fs.existsSync(this.djlintPath)) {
        return false;
      }

      // Test if djLint is installed and working
      await execa(this.djlintPath, ["-m", "djlint", "--version"], {
        timeout: 10_000,
      });
      
      return true;
    } catch {
      return false;
    }
  }

  private async createVenv(): Promise<void> {
    // Remove existing venv if it exists but is invalid
    if (fs.existsSync(this.venvPath)) {
      fs.rmSync(this.venvPath, { force: true, recursive: true });
    }

    // Create new virtual environment
    const pythonCmd = IsolatedDjlintRunner.findPythonExecutable();
    await execa(pythonCmd, ["-m", "venv", this.venvPath], {
      timeout: 30_000,
    });
  }

  private async installDjlint(): Promise<void> {
    // Install djLint in the virtual environment
    try {
      await execa(this.djlintPath, ["-m", "pip", "install", "-U", "djlint"], {
        // 2 minutes timeout for installation
        timeout: 120_000, 
      });
    } catch (e: unknown) {
      this.outputChannel.error(`Failed to install djLint in isolated environment: ${String(e)}`);
      throw new Error(`Failed to install djLint in isolated environment. Check your internet connection and try again.`);
    }
  }
}