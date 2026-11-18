import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

/**
 * How djLint runs on the Python of its npm package. `-I` shuts out other Pythons, as the package's own command does, and so ignores PYTHONPATH.
 * What it names goes after the package's own modules instead, which keeps a custom rule's python_module importable from the workspace, as with any other djLint, while nothing there can stand in for one of djLint's.
 */
export const NPM_PYTHON_ARGS: readonly string[] = [
  "-I",
  "-c",
  "import os, sys; sys.path += filter(None, os.environ.get('PYTHONPATH', '').split(os.pathsep)); from djlint._cli import main; sys.argv[0] = 'djlint'; sys.exit(main())",
];

let muslPromise: Promise<boolean> | undefined;

// What the detect-libc package looks at: ldd is a script, which on musl runs musl's loader.
async function isMusl(): Promise<boolean> {
  try {
    const ldd = await readFile("/usr/bin/ldd", "latin1");
    return ldd.includes("musl");
  } catch {
    return false;
  }
}

/**
 * The name of the package that holds djLint's Python for this machine, as the djlint package names it.
 * @returns A name such as `@djlint/linux-x64-gnu`.
 */
export async function npmPlatformPackage(): Promise<string> {
  const { arch, platform } = process;
  if (platform !== "linux") {
    return `@djlint/${platform}-${arch}`;
  }
  muslPromise ??= isMusl();
  return `@djlint/linux-${arch}-${(await muslPromise) ? "musl" : "gnu"}`;
}

/**
 * The Python of the djlint npm package that a folder sees, where Node would find the package: in a node_modules folder there or above.
 * @param folder - The folder of the document djLint runs for.
 * @returns The interpreter's path, or null when there is no such package, its platform package is missing, or it is an older one that ran pip.
 */
export async function findNpmPython(folder: string): Promise<string | null> {
  try {
    // A package manager such as pnpm links the package in, and puts what it depends on next to where the link leads.
    const manifest = await realpath(
      createRequire(path.join(folder, "package.json")).resolve("djlint/package.json"),
    );
    const platformManifest = createRequire(manifest).resolve(
      `${await npmPlatformPackage()}/package.json`,
    );
    const contents: unknown = JSON.parse(await readFile(platformManifest, "utf8"));
    const python =
      typeof contents === "object" && contents !== null && "python" in contents
        ? contents.python
        : void 0;
    return typeof python === "string" ? path.join(path.dirname(platformManifest), python) : null;
  } catch {
    return null;
  }
}
