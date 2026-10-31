import path from "node:path";
import * as vscode from "vscode";
import type { ProjectSnapshot, RunRequest } from "./protocol.js";

const CONFIG_FILES: ReadonlySet<string> = new Set([
  ".djlint.toml",
  ".djlint_rules.yaml",
  ".djlintrc",
  ".editorconfig",
  ".gitignore",
  "djlint.toml",
  "pyproject.toml",
]);

interface NamedFile {
  file: string;
  option: string;
  uri: vscode.Uri;
  value: string;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return void 0;
  }
}

// One request per folder, where asking for each file by name would be seven. Each can be a network round trip, and this runs on every format and lint.
async function listConfigFiles(
  folder: vscode.Uri,
  directory: string,
): Promise<string[]> {
  const uri = vscode.Uri.joinPath(folder, ...directory.split("/"));
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .filter(
        ([name, type]) =>
          CONFIG_FILES.has(name) &&
          // eslint-disable-next-line no-bitwise -- a bit field, as a symbolic link to a file sets two bits
          (type & vscode.FileType.File) !== 0,
      )
      .map(([name]) => (directory === "" ? name : `${directory}/${name}`));
  } catch {
    return [];
  }
}

// Not path.resolve() or path.isAbsolute(): in a browser on Windows, fsPath is written with backslashes, which the browser's path module takes for a relative path and resolves against a process that does not exist.
function isAbsolute(value: string): boolean {
  return /^(?:[a-z]:)?\//iu.test(value);
}

function insideFolder(value: string, folder: vscode.Uri): string | undefined {
  if (isAbsolute(value)) {
    const base = folder.fsPath.replaceAll("\\", "/").replace(/\/$/u, "");
    return value.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      ? value.slice(base.length + 1)
      : void 0;
  }
  const relative = path.posix.normalize(value);
  return relative === ".." || relative.startsWith("../") ? void 0 : relative;
}

function locateNamedFile(
  option: string,
  value: string,
  folder: vscode.Uri,
): NamedFile {
  const slashed = value.replaceAll("\\", "/");
  const inside = insideFolder(slashed, folder);
  if (inside != null) {
    const uri = vscode.Uri.joinPath(folder, ...inside.split("/"));
    return { file: inside, option, uri, value };
  }
  const uri = isAbsolute(slashed)
    ? vscode.Uri.file(value)
    : vscode.Uri.joinPath(folder, ...slashed.split("/"));
  const file = `.outside/${option}/${path.posix.basename(slashed)}`;
  return { file, option, uri, value };
}

// Without a host filesystem to mount, the files djLint looks for are read through VS Code and handed over with the request.
export async function readProject(
  document: vscode.TextDocument,
  pathOptions: RunRequest["pathOptions"],
  outputChannel: vscode.LogOutputChannel,
): Promise<
  | {
      cwd: undefined;
      pathOptions: RunRequest["pathOptions"];
      project: ProjectSnapshot;
    }
  | undefined
> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder == null) {
    return void 0;
  }
  const cwd = path.posix.dirname(
    path.posix.relative(folder.uri.path, document.uri.path),
  );
  const parts = cwd === "." ? [] : cwd.split("/");
  const parents = parts.map((_, depth) => parts.slice(0, depth + 1).join("/"));
  const listed = await Promise.all(
    ["", ...parents].map(async (directory) =>
      listConfigFiles(folder.uri, directory),
    ),
  );
  const candidates = listed.flat();
  const texts = await Promise.all(
    candidates.map(async (file) =>
      readText(vscode.Uri.joinPath(folder.uri, ...file.split("/"))),
    ),
  );
  const named = Object.entries(pathOptions).map(([option, value]) =>
    locateNamedFile(option, value, folder.uri),
  );
  const namedTexts = await Promise.all(
    named.map(async ({ uri }) => readText(uri)),
  );

  const files: ProjectSnapshot["files"] = {};
  for (const [index, file] of candidates.entries()) {
    const text = texts[index];
    if (text != null) {
      files[file] = text;
    }
  }
  const guestPathOptions: RunRequest["pathOptions"] = {};
  for (const [index, { file, option, value }] of named.entries()) {
    const text = namedTexts[index];
    if (text == null) {
      outputChannel.warn(`Ignoring djlint.${option}: cannot read "${value}".`);
    } else {
      files[file] = text;
      guestPathOptions[option] = `/project/${file}`;
    }
  }
  return {
    cwd: void 0,
    pathOptions: guestPathOptions,
    project: { cwd, files },
  };
}
