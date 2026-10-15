// Writes the licenses of the third-party software bundled into the extension.
// Usage: node build/third-party-notices.mjs OUTPUT INPUT...
// Each .json input is an esbuild metafile, whose bundled npm packages get
// their license files listed. Each .txt input is copied in as is, in order.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [output = "", ...inputs] = process.argv.slice(2);
if (output === "" || inputs.length === 0) {
  throw new Error("usage: third-party-notices.mjs OUTPUT INPUT...");
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-.]|$)/iu;
const RULE = "=".repeat(80);

/** @type {Set<string>} */
const roots = new Set();
const bundledFiles = inputs
  .filter((input) => input.endsWith(".json"))
  .flatMap((metafile) => {
    const meta =
      /** @type {{ inputs: Record<string, unknown> }} */
      (JSON.parse(readFileSync(metafile, "utf8")));
    return Object.keys(meta.inputs);
  });
for (const file of bundledFiles) {
  const parts = file.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index === -1) {
    continue;
  }
  const isScoped = parts[index + 1]?.startsWith("@") ?? false;
  roots.add(parts.slice(0, index + (isScoped ? 3 : 2)).join("/"));
}

const npmSections = [];
for (const root of roots) {
  const pkg =
    /** @type {{ name: string, version: string, license: string }} */
    (JSON.parse(readFileSync(`${root}/package.json`, "utf8")));
  const files = readdirSync(root)
    .filter((name) => LICENSE_FILE.test(name))
    .toSorted((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new Error(`${pkg.name} has no license file in ${root}`);
  }
  const texts = files.map((name) =>
    readFileSync(path.join(root, name), "utf8").replaceAll("\r", "").trim(),
  );
  npmSections.push(
    `${RULE}\n${pkg.name} ${pkg.version} (${pkg.license})\n\n${texts.join("\n\n")}\n`,
  );
}

const parts = [];
let isNpmWritten = false;
for (const input of inputs) {
  if (input.endsWith(".json")) {
    if (!isNpmWritten) {
      parts.push(
        `Licenses of the npm packages bundled into dist/.\n\n${npmSections.toSorted((a, b) => a.localeCompare(b)).join("\n")}`,
      );
      isNpmWritten = true;
    }
  } else {
    parts.push(readFileSync(input, "utf8").replaceAll("\r", "").trim());
  }
}

writeFileSync(output, `${parts.join(`\n\n${"#".repeat(80)}\n\n`)}\n`);
