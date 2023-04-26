import { Uri } from "vscode";

export interface IExtensionApi {
  readonly environments: {
    getActiveEnvironmentPath(resource: Uri): EnvironmentPath;
    resolveEnvironment(
      environment: EnvironmentPath
    ): Promise<ResolvedEnvironment | undefined>;
  };
}

interface ResolvedEnvironment {
  readonly executable: {
    readonly uri: Uri | undefined;
  };
}

interface EnvironmentPath {
  readonly id: string;
  readonly path: string;
}
