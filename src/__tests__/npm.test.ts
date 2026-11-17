// Finding the Python of the djlint npm package where Node would find the package.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findNpmPython, npmPlatformPackage } from "../engine/subprocess/npm.js";

async function writePackage(folder: string, manifest: object): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "package.json"), JSON.stringify(manifest));
}

/**
 * Lays out djlint and its package for this machine as a package manager would.
 * @param nodeModules - The node_modules folder they go in.
 * @param python - What the platform package names as its Python, if anything.
 */
async function installDjlint(nodeModules: string, python?: string): Promise<void> {
  await writePackage(path.join(nodeModules, "djlint"), { name: "djlint" });
  const platform = await npmPlatformPackage();
  await writePackage(path.join(nodeModules, ...platform.split("/")), {
    name: platform,
    ...(python != null && { python }),
  });
}

describe(findNpmPython, () => {
  let project: string;

  beforeEach(async () => {
    // The real path, as the lookup gives one: the temporary folder is behind a link on macOS, and has a short name on Windows runners.
    project = await realpath(await mkdtemp(path.join(tmpdir(), "djlint-npm-")));
  });

  afterEach(async () => {
    await rm(project, { force: true, recursive: true });
  });

  it("finds the Python of a hoisted install, as npm, Yarn and Bun lay it out", async () => {
    await installDjlint(path.join(project, "node_modules"), "python/bin/python3");
    const platform = await npmPlatformPackage();
    await expect(findNpmPython(project)).resolves.toBe(
      path.join(project, "node_modules", ...platform.split("/"), "python", "bin", "python3"),
    );
  });

  it("looks in the folders above, as Node does", async () => {
    await installDjlint(path.join(project, "node_modules"), "python/python.exe");
    const templates = path.join(project, "app", "templates");
    await mkdir(templates, { recursive: true });
    await expect(findNpmPython(templates)).resolves.toMatch(/python\.exe$/u);
  });

  it("follows the link pnpm puts djlint behind to the packages next to it", async () => {
    const store = path.join(project, "node_modules", ".pnpm", "djlint@1.54.0", "node_modules");
    await installDjlint(store, "python/bin/python3");
    // A junction needs no rights on Windows, and is a plain link elsewhere.
    await symlink(
      path.join(store, "djlint"),
      path.join(project, "node_modules", "djlint"),
      "junction",
    );
    const platform = await npmPlatformPackage();
    await expect(findNpmPython(project)).resolves.toBe(
      path.join(store, ...platform.split("/"), "python", "bin", "python3"),
    );
  });

  it("finds nothing without djlint, or without its package for this machine", async () => {
    await expect(findNpmPython(project)).resolves.toBeNull();
    await writePackage(path.join(project, "node_modules", "djlint"), { name: "djlint" });
    await expect(findNpmPython(project)).resolves.toBeNull();
  });

  it("finds nothing in an older djlint package, which ran pip", async () => {
    await installDjlint(path.join(project, "node_modules"));
    await expect(findNpmPython(project)).resolves.toBeNull();
  });
});

describe(npmPlatformPackage, () => {
  it("names the package after Node's platform and processor, and the libc on Linux", async () => {
    const name = await npmPlatformPackage();
    expect(name).toMatch(/^@djlint\/[a-z0-9]+-[a-z0-9]+(?:-(?:gnu|musl))?$/u);
    expect(name.startsWith(`@djlint/${process.platform}-${process.arch}`)).toBe(true);
  });
});
