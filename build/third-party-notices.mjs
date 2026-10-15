// Writes the licenses of the npm packages esbuild bundled into the extension.
// Usage: node build/third-party-notices.mjs OUTPUT METAFILE...
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [output = "", ...metafiles] = process.argv.slice(2);
if (output === "" || metafiles.length === 0) {
  throw new Error("usage: third-party-notices.mjs OUTPUT METAFILE...");
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-.]|$)/iu;
const RULE = "=".repeat(80);

/** @type {Set<string>} */
const roots = new Set();
for (const metafile of metafiles) {
  const meta =
    /** @type {{ inputs: Record<string, unknown> }} */
    (JSON.parse(readFileSync(metafile, "utf8")));
  for (const input of Object.keys(meta.inputs)) {
    const parts = input.split("/");
    const index = parts.lastIndexOf("node_modules");
    if (index === -1) {
      continue;
    }
    const isScoped = parts[index + 1]?.startsWith("@") ?? false;
    roots.add(parts.slice(0, index + (isScoped ? 3 : 2)).join("/"));
  }
}

const sections = [];
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
  sections.push(
    `${RULE}\n${pkg.name} ${pkg.version} (${pkg.license})\n\n${texts.join("\n\n")}\n`,
  );
}

writeFileSync(
  output,
  `Licenses of the third-party software bundled into this extension.\n\n${sections.toSorted((a, b) => a.localeCompare(b)).join("\n")}`,
);
