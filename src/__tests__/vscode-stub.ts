// Stand-in for the `vscode` module, aliased in vitest.config.ts. It emulates
// the parts of the API whose behaviour the extension depends on (URIs, relative
// paths, cancellation tokens) and records the rest, so suites can inspect what
// a user would see. `control` is the suites' handle on it.
import path from "node:path";

type Listener<T> = (value: T) => void;

interface Disposable {
  dispose: () => void;
}

export type WorkspaceEventKind =
  "close" | "config" | "extensions" | "open" | "save" | "trust";

const URI_REGEX =
  /^(?<scheme>[a-z][a-z\d+.-]*):(?:\/\/(?<authority>[^/?#]*))?(?<path>[^?#]*)(?:\?(?<query>[^#]*))?(?:#(?<fragment>.*))?$/iu;

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = "",
    readonly fragment = "",
  ) {}

  static file(fsPath: string): Uri {
    const slashed =
      process.platform === "win32" ? fsPath.replaceAll("\\", "/") : fsPath;
    return new Uri(
      "file",
      "",
      slashed.startsWith("/") ? slashed : `/${slashed}`,
    );
  }

  static parse(value: string): Uri {
    const groups = URI_REGEX.exec(value)?.groups;
    if (!groups) {
      throw new Error(`Not a URI: ${value}`);
    }
    return new Uri(
      groups["scheme"] ?? "",
      groups["authority"] ?? "",
      groups["path"] ?? "",
      groups["query"] ?? "",
      groups["fragment"] ?? "",
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(
      base.scheme,
      base.authority,
      path.posix.join(base.path, ...segments),
      base.query,
      base.fragment,
    );
  }

  get fsPath(): string {
    const hasDrive = /^\/[a-z]:/iu.test(this.path);
    const local = hasDrive
      ? `${this.path.charAt(1).toLowerCase()}${this.path.slice(2)}`
      : this.path;
    return process.platform === "win32" ? local.replaceAll("/", "\\") : local;
  }

  toString(): string {
    const authority =
      this.authority || this.scheme === "file" ? `//${this.authority}` : "";
    const query = this.query && `?${this.query}`;
    const fragment = this.fragment && `#${this.fragment}`;
    return `${this.scheme}:${authority}${this.path}${query}${fragment}`;
  }
}

export interface WorkspaceFolder {
  uri: Uri;
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

export interface TextEditRecord {
  range: Range;
  newText: string;
}

export const TextEdit = {
  replace: (range: Range, newText: string): TextEditRecord => ({
    newText,
    range,
  }),
};

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export class Diagnostic {
  source: string | undefined;
  code: { target: Uri; value: string } | undefined;

  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number = DiagnosticSeverity.Error,
  ) {}
}

export class CancellationError extends Error {}

export class CancellationTokenSource {
  readonly #listeners = new Set<() => void>();

  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void): Disposable => {
      if (this.token.isCancellationRequested) {
        const timer = setTimeout(listener, 0);
        return {
          dispose: () => {
            clearTimeout(timer);
          },
        };
      }
      this.#listeners.add(listener);
      return {
        dispose: () => {
          this.#listeners.delete(listener);
        },
      };
    },
  };

  cancel(): void {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.token.isCancellationRequested = true;
    for (const listener of this.#listeners) {
      listener();
    }
    this.#listeners.clear();
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class EventEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export interface LogLine {
  level: "debug" | "error" | "info" | "trace" | "warn";
  message: string;
}

export class RecordingChannel {
  readonly lines: LogLine[] = [];
  shownCount = 0;

  of(level: LogLine["level"]): string[] {
    return this.lines
      .filter((line) => line.level === level)
      .map(({ message }) => message);
  }

  trace(message: unknown): void {
    this.lines.push({ level: "trace", message: String(message) });
  }

  debug(message: unknown): void {
    this.lines.push({ level: "debug", message: String(message) });
  }

  info(message: unknown): void {
    this.lines.push({ level: "info", message: String(message) });
  }

  warn(message: unknown): void {
    this.lines.push({ level: "warn", message: String(message) });
  }

  error(message: unknown): void {
    this.lines.push({ level: "error", message: String(message) });
  }

  show(): void {
    this.shownCount += 1;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  dispose(): void {}
}

interface FormattingProviderRecord {
  selector: unknown;
  provider: unknown;
}

function initialState(): {
  activeDocument: unknown;
  activeEditorListeners: Set<() => void>;
  files: Map<string, string>;
  statusItems: StatusItem[];
  commands: Map<string, () => unknown>;
  configuration: Record<string, unknown>;
  diagnostics: Map<string, readonly Diagnostic[]>;
  documents: readonly unknown[];
  errorMessageChoice: string | undefined;
  extensions: Map<string, unknown>;
  formattingProviders: FormattingProviderRecord[];
  isTrusted: boolean;
  outputChannels: RecordingChannel[];
  shownErrors: string[];
  visibleDocuments: readonly unknown[];
  workspaceFolders: readonly WorkspaceFolder[];
} {
  return {
    activeDocument: void 0,
    activeEditorListeners: new Set(),
    files: new Map(),
    statusItems: [],
    commands: new Map(),
    configuration: {},
    diagnostics: new Map(),
    documents: [],
    errorMessageChoice: void 0,
    extensions: new Map(),
    formattingProviders: [],
    isTrusted: true,
    outputChannels: [],
    shownErrors: [],
    visibleDocuments: [],
    workspaceFolders: [],
  };
}

/** What the suites set up and inspect. `resetVscode()` restores it. */
export const control = initialState();

const workspaceListeners = new Map<
  WorkspaceEventKind,
  Set<Listener<unknown>>
>();

export function resetVscode(): void {
  Object.assign(control, initialState());
  workspaceListeners.clear();
}

/** Delivers a workspace event to the listeners the extension registered. */
export function fireWorkspaceEvent(
  kind: WorkspaceEventKind,
  value?: unknown,
): void {
  for (const listener of workspaceListeners.get(kind) ?? []) {
    listener(value);
  }
}

export function workspaceListenerCount(kind: WorkspaceEventKind): number {
  return workspaceListeners.get(kind)?.size ?? 0;
}

function onWorkspaceEvent<T>(
  kind: WorkspaceEventKind,
): (listener: Listener<T>) => Disposable {
  return (listener) => {
    const untyped = listener as Listener<unknown>;
    const listeners = workspaceListeners.get(kind) ?? new Set();
    workspaceListeners.set(kind, listeners);
    listeners.add(untyped);
    return {
      dispose: () => {
        listeners.delete(untyped);
      },
    };
  };
}

function findWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
  return control.workspaceFolders
    .filter(
      (folder) =>
        folder.uri.scheme === uri.scheme &&
        folder.uri.authority === uri.authority &&
        `${uri.path}/`.startsWith(`${folder.uri.path}/`),
    )
    .toSorted((a, b) => b.uri.path.length - a.uri.path.length)[0];
}

export function setActiveDocument(document: unknown): void {
  control.activeDocument = document;
  for (const listener of control.activeEditorListeners) {
    listener();
  }
}

export const FileType = { Directory: 2, File: 1, SymbolicLink: 64 };

export const workspace = {
  fs: {
    readDirectory: async (uri: Uri): Promise<[string, number][]> => {
      const prefix = `${uri.toString().replace(/\/$/u, "")}/`;
      const entries = new Map<string, number>();
      for (const file of control.files.keys()) {
        if (!file.startsWith(prefix)) {
          continue;
        }
        const [name = "", ...rest] = file.slice(prefix.length).split("/");
        entries.set(name, rest.length > 0 ? FileType.Directory : FileType.File);
      }
      if (entries.size === 0) {
        throw new Error(`no such folder: ${uri.toString()}`);
      }
      return [...entries];
    },
    readFile: async (uri: Uri): Promise<Uint8Array> => {
      const text = control.files.get(uri.toString());
      if (text == null) {
        throw new Error(`no such file: ${uri.toString()}`);
      }
      return new TextEncoder().encode(text);
    },
  },
  // Without a folder, VS Code answers with the path it was given.
  asRelativePath: (uri: Uri, _includeWorkspaceFolder?: boolean): string => {
    const folder = findWorkspaceFolder(uri);
    return folder ? path.posix.relative(folder.uri.path, uri.path) : uri.fsPath;
  },
  getConfiguration: (
    _section?: string,
    _scope?: unknown,
  ): { get: (key: string) => unknown } => ({
    get: (key) => control.configuration[key],
  }),
  getWorkspaceFolder: findWorkspaceFolder,
  get workspaceFolders(): readonly WorkspaceFolder[] {
    return control.workspaceFolders;
  },
  get isTrusted(): boolean {
    return control.isTrusted;
  },
  onDidChangeConfiguration: onWorkspaceEvent<unknown>("config"),
  onDidCloseTextDocument: onWorkspaceEvent<unknown>("close"),
  onDidGrantWorkspaceTrust: onWorkspaceEvent<unknown>("trust"),
  onDidOpenTextDocument: onWorkspaceEvent<unknown>("open"),
  onDidSaveTextDocument: onWorkspaceEvent<unknown>("save"),
  get textDocuments(): readonly unknown[] {
    return control.documents;
  },
};

export const window = {
  get activeTextEditor(): { document: unknown } | undefined {
    return control.activeDocument == null
      ? void 0
      : { document: control.activeDocument };
  },
  onDidChangeActiveTextEditor: (
    listener: () => void,
  ): { dispose: () => void } => {
    control.activeEditorListeners.add(listener);
    return {
      dispose: (): void => {
        control.activeEditorListeners.delete(listener);
      },
    };
  },
  createOutputChannel: (
    _name: string,
    _options?: unknown,
  ): RecordingChannel => {
    const channel = new RecordingChannel();
    control.outputChannels.push(channel);
    return channel;
  },
  showErrorMessage: async (
    message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    control.shownErrors.push(message);
    return control.errorMessageChoice;
  },
  get visibleTextEditors(): readonly { document: unknown }[] {
    return control.visibleDocuments.map((document) => ({ document }));
  },
};

export const extensions = {
  getExtension: (id: string): unknown => control.extensions.get(id),
  onDidChange: onWorkspaceEvent<unknown>("extensions"),
};

interface StatusItem {
  command?: unknown;
  detail?: string;
  dispose: () => void;
  id: string;
  name?: string;
  selector: unknown;
  text: string;
}

export const languages = {
  createLanguageStatusItem: (id: string, selector: unknown): StatusItem => {
    const item: StatusItem = { dispose: () => void 0, id, selector, text: "" };
    control.statusItems.push(item);
    return item;
  },
  createDiagnosticCollection: (
    _name?: string,
  ): Disposable & {
    delete: (uri: Uri) => void;
    has: (uri: Uri) => boolean;
    set: (uri: Uri, diagnostics: readonly Diagnostic[]) => void;
  } => ({
    delete: (uri) => {
      control.diagnostics.delete(uri.toString());
    },
    dispose: () => {
      control.diagnostics.clear();
    },
    has: (uri) => control.diagnostics.has(uri.toString()),
    set: (uri, diagnostics) => {
      control.diagnostics.set(uri.toString(), diagnostics);
    },
  }),
  registerDocumentFormattingEditProvider: (
    selector: unknown,
    provider: unknown,
  ): Disposable => {
    const record = { provider, selector };
    control.formattingProviders.push(record);
    return {
      dispose: () => {
        control.formattingProviders = control.formattingProviders.filter(
          (other) => other !== record,
        );
      },
    };
  },
};

export const commands = {
  registerCommand: (id: string, handler: () => unknown): Disposable => {
    control.commands.set(id, handler);
    return {
      dispose: () => {
        control.commands.delete(id);
      },
    };
  },
};
