import { Uri } from "vscode";

export interface IExtensionApi {
  readonly environments: {
    getActiveEnvironmentPath(resource: Uri): EnvironmentPath;
    resolveEnvironment(
      environment: EnvironmentPath
    ): Promise<ResolvedEnvironment | undefined>;
  };
}

type ResolvedEnvironment = {
  readonly executable: {
    readonly uri: Uri | undefined;
  };
};

type EnvironmentPath = {
  readonly id: string;
  readonly path: string;
};
