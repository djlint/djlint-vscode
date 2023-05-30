import type vscode from "vscode";

export interface IExtensionApi {
  readonly environments: {
    getActiveEnvironmentPath: (resource: vscode.Uri) => EnvironmentPath;
    resolveEnvironment: (
      environment: EnvironmentPath
    ) => Promise<ResolvedEnvironment | undefined>;
  };
}

interface ResolvedEnvironment {
  readonly executable: {
    readonly uri: vscode.Uri | undefined;
  };
}

interface EnvironmentPath {
  readonly id: string;
  readonly path: string;
}
